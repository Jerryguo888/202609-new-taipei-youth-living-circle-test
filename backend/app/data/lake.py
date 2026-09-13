"""把抓好的資料推上 S3 資料湖，讓 Athena 查得到。

寫出去的格式是 **JSONL（一行一筆）**，不是原本 `/data/records/*.json` 那種
`{"table": ..., "rows": [...]}` 的包裝結構。這一點很容易踩：Athena 的 JSON
SerDe 是「一行一個 JSON 物件」，餵給它一個外層物件裡包陣列的檔案，查出來會是
一列 NULL，而且不會報錯 —— 看起來像「表是空的」而不是「格式錯了」。

欄位名必須跟 `metrics.py` / `records.py` 產生的 SQL 完全一致，否則同樣是查到
NULL 而不是報錯。指標快照裡用的是 `age20_29`，但 SQL 寫的是 `age_20_29`，
所以這裡會改名 —— 這種不一致沒有測試會抓不到。

分層：
    s3://<bucket>/curated/<table>/<table>.jsonl
表的 location 指到 `curated/<table>/`，Athena 會讀那個前綴下的所有檔案，
所以每次覆寫同一個 key 就等於整表換掉，不需要管分割。
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from app import config
from app.data import records as records_module

logger = logging.getLogger("living-circle-chat.lake")


class LakeError(RuntimeError):
    """設定或上傳問題；CLI 會轉成非零結束碼。"""


# Athena 表名 -> 欄位順序。順序只影響可讀性，但名稱必須與查詢用的 SQL 一致。
RECORD_TABLE_COLUMNS = {
    "childcare_facilities": (
        "district", "name", "kind", "operator", "address", "phone", "capacity",
    ),
    "vaccine_clinics": (
        "district", "name", "address", "phone",
        "clinic_type", "reservation", "self_paid", "remark",
    ),
    "vaccine_schedules": ("district", "vaccine_hours", "bcg_hours", "remark", "updated"),
    "youbike_stations": (
        "district", "name", "station_id", "address", "docks", "lat", "lon",
    ),
}

# 從指標快照衍生出來的兩張表，query_metrics 會查它們
METRIC_TABLES = ("population_youth", "childcare_pressure")


def _client():
    import boto3  # 延後 import：沒有要用資料湖的部署不必付這個成本

    return boto3.client("s3", config=config.boto_config(read_timeout=60))


def require_config() -> None:
    if not config.S3_DATA_BUCKET:
        raise LakeError(
            "S3_DATA_BUCKET 未設定，無法上傳資料湖。"
            "注意這是資料湖的 bucket，不是知識庫那一個（KB_BUCKET）。"
        )


def _key_for(table: str) -> str:
    prefix = config.S3_CURATED_PREFIX.strip("/")
    return f"{prefix}/{table}/{table}.jsonl"


def to_jsonl(rows: list[dict], columns: tuple[str, ...]) -> bytes:
    """一行一個 JSON 物件。只輸出白名單欄位，順序固定。

    缺的欄位補 None 而不是省略：省略的話 Athena 那一格會是 NULL，行為一樣，
    但輸出檔的每一行欄位數不同，人在 S3 上點開看會以為資料壞了。
    """
    lines = []
    for row in rows:
        record = {column: row.get(column) for column in columns}
        lines.append(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
    return ("\n".join(lines) + "\n").encode("utf-8")


def snapshot_to_population_youth(snapshot: dict) -> list[dict]:
    """指標快照 -> population_youth 的逐列資料。

    快照是 `by_year[year][district] = {age20_29, age30_34, age20_34}` 的嵌套結構，
    Athena 要的是攤平的一列一區一年。欄位名要改成 SQL 用的 age_20_29 / age_30_34。
    age20_34 不輸出：它是前兩者的和，SQL 直接寫 SUM(age_20_29 + age_30_34)，
    存第三個欄位只會多一個可能對不起來的地方。
    """
    out = []
    by_year = (snapshot.get("metrics", {}).get("youth_population", {}).get("by_year")) or {}
    for year, districts in by_year.items():
        for district, values in districts.items():
            out.append(
                {
                    "district": district,
                    "year": str(year),
                    "age_20_29": values.get("age20_29"),
                    "age_30_34": values.get("age30_34"),
                }
            )
    return out


def snapshot_to_childcare_pressure(snapshot: dict) -> list[dict]:
    """指標快照 -> childcare_pressure。SQL 用的是 MAX(youth_per_center)。"""
    out = []
    by_district = (
        snapshot.get("metrics", {}).get("childcare_pressure", {}).get("by_district")
    ) or {}
    for district, values in by_district.items():
        out.append(
            {
                "district": district,
                "youth_per_center": values.get("youth_per_center"),
            }
        )
    return out


METRIC_TABLE_BUILDERS = {
    "population_youth": (
        ("district", "year", "age_20_29", "age_30_34"),
        snapshot_to_population_youth,
    ),
    "childcare_pressure": (
        ("district", "youth_per_center"),
        snapshot_to_childcare_pressure,
    ),
}


def _read_records(table: str) -> list[dict]:
    """讀 `/data/records/<table>.json`（沒有就退回 image 內建的那份）。"""
    path, _bundled = records_module.resolve_records_path(table)
    if not Path(path).exists():
        return []
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return payload.get("rows") or []


def sync(only: list[str] | None = None, log=print) -> dict:
    """把所有表推上 S3。回傳 {"uploaded": {表: 筆數}, "skipped": [說明]}。"""
    require_config()
    client = _client()
    bucket = config.S3_DATA_BUCKET

    uploaded: dict[str, int] = {}
    skipped: list[str] = []

    def put(table: str, rows: list[dict], columns: tuple[str, ...]) -> None:
        if not rows:
            # 空表不要上傳。覆寫成 0 筆等於把 Athena 那張表清空，
            # 而上游暫時抓不到資料不該讓查詢直接查不到東西。
            skipped.append(f"{table}: 0 筆，保留 S3 上的既有版本")
            log(f"  跳過 {table}：0 筆")
            return
        body = to_jsonl(rows, columns)
        key = _key_for(table)
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentType="application/x-ndjson",
            ServerSideEncryption="AES256",
        )
        uploaded[table] = len(rows)
        log(f"  上傳 s3://{bucket}/{key}（{len(rows)} 筆，{len(body) / 1024:.0f} KB）")

    log("推送逐筆名冊表")
    for table, columns in RECORD_TABLE_COLUMNS.items():
        if only and table not in only:
            continue
        put(table, _read_records(table), columns)

    log("推送指標表（由指標快照衍生）")
    wanted_metrics = [t for t in METRIC_TABLES if not only or t in only]
    if wanted_metrics:
        from app.data import metrics as metrics_module

        try:
            snapshot = metrics_module.load_snapshot()
        except Exception as error:  # noqa: BLE001
            raise LakeError(f"讀不到指標快照，無法產生指標表：{error}") from error
        for table in wanted_metrics:
            columns, builder = METRIC_TABLE_BUILDERS[table]
            put(table, builder(snapshot), columns)

    log(f"完成：上傳 {len(uploaded)} 張表，跳過 {len(skipped)} 張")
    return {"uploaded": uploaded, "skipped": skipped}
