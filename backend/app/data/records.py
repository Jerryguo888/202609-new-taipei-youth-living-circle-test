"""逐筆記錄查詢層（名冊、站點、時段）。

跟 metrics.py 的分工：
    metrics.py  彙總值 —— 排名、加總、逐年變化
    records.py  逐筆記錄 —— 「板橋區有哪些公共托育中心」

這些名冊**不進知識庫**。原因有兩個，都很實際：
  1. 向量檢索比的是語意相似度而不是欄位相等，問板橋很容易混進新莊的片段；
     `WHERE district = ?` 不會有這個問題。
  2. 地址電話經過 embedding 再讓模型重述，是最容易產生幻覺的地方。
     直接回傳資料列，模型沒有機會「重寫」門牌號碼。

安全模型與 metrics.py 相同：模型只能填列舉過的 table 與受驗證的過濾值，
SQL 由固定樣板組出來，值一律走 Athena 的 ExecutionParameters。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from app import config
# 設定值一律從 config 拿，不要透過 metrics 轉手 —— 那會讓 records 看起來依賴
# metrics 的設定，實際上兩者只是共用同一組環境變數。
from app.config import (
    ATHENA_DATABASE,
    ATHENA_OUTPUT,
    ATHENA_TIMEOUT_SECONDS,
    ATHENA_WORKGROUP,
    METRIC_BACKEND,
)
from app.data.metrics import MetricError, known_districts

logger = logging.getLogger("living-circle-chat.records")

# 兩層路徑：掛載進來的可寫目錄優先，image 內建的那份只是「還沒跑過第一次更新」
# 時的墊底。分兩層是為了讓資料更新跟程式部署脫鉤。
RECORDS_DIR = config.RECORDS_DIR
BUNDLED_RECORDS_DIR = config.BUNDLED_RECORDS_DIR


def resolve_records_path(table: str) -> tuple[Path, bool]:
    """回傳 (要讀的檔案, 是否為 image 內建的墊底版本)。"""
    live = RECORDS_DIR / f"{table}.json"
    if live.exists():
        return live, False
    return BUNDLED_RECORDS_DIR / f"{table}.json", True

MAX_LIMIT = 50
DEFAULT_LIMIT = 10
# 單一欄位的字串上限。時段與備註欄位偶爾很長，整份回傳會把上下文吃光。
MAX_FIELD_CHARS = 300


@dataclass(frozen=True)
class RecordTable:
    key: str
    label: str
    description: str
    columns: tuple[str, ...]
    # 關鍵字會比對這些欄位（模型不能自己指定要比對哪一欄）
    searchable: tuple[str, ...]
    athena_table: str


TABLES: dict[str, RecordTable] = {
    "childcare_facilities": RecordTable(
        key="childcare_facilities",
        label="托育機構名冊",
        description=(
            "公共托育中心與私立托嬰機構的逐筆名冊，含名稱、地址、電話。"
            "私立托嬰機構有 capacity（核定收托人數），公共托育中心沒有這個欄位。"
            "目前只涵蓋 21 個行政區。"
        ),
        columns=("district", "name", "kind", "operator", "address", "phone", "capacity"),
        searchable=("name", "operator", "address", "kind"),
        athena_table="childcare_facilities",
    ),
    "vaccine_clinics": RecordTable(
        key="vaccine_clinics",
        label="疫苗接種院所名冊",
        description=(
            "提供疫苗接種的診所與醫院，含地址、電話、院所層級、預約方式。"
            "self_paid 欄位的值是「有自費疫苗」或「僅公費疫苗」，"
            "所以要找自費疫苗的院所時 keyword 填「自費」即可。"
        ),
        columns=(
            "district", "name", "address", "phone",
            "clinic_type", "reservation", "self_paid", "remark",
        ),
        # self_paid 存的是「有自費疫苗」／「僅公費疫苗」，所以 keyword="自費"
        # 只會命中前者。這是刻意設計的，見 fetch_sources.py 的說明。
        searchable=("name", "address", "clinic_type", "self_paid", "remark"),
        athena_table="vaccine_clinics",
    ),
    "vaccine_schedules": RecordTable(
        key="vaccine_schedules",
        label="各區衛生所接種時段",
        description=(
            "每個行政區衛生所的常規疫苗與 BCG 接種時段，內容是文字描述的時間，"
            "例如「週一至週五上午8:30~11:30」。"
        ),
        columns=("district", "vaccine_hours", "bcg_hours", "remark", "updated"),
        searchable=("vaccine_hours", "bcg_hours", "remark"),
        athena_table="vaccine_schedules",
    ),
    "youbike_stations": RecordTable(
        key="youbike_stations",
        label="YouBike 2.0 站點",
        description=(
            "站點位置與總柱數（docks）。"
            "刻意不含可借車輛數：那是即時值，放進季度快照會變成看起來精確但過期"
            "好幾個月的數字。要即時資料需另外接高頻來源。"
        ),
        columns=(
            "district", "name", "station_id", "address",
            "docks", "available", "updated", "lat", "lon",
        ),
        searchable=("name", "address"),
        athena_table="youbike_stations",
    ),
}


@dataclass
class LookupQuery:
    table: str
    district: str | None = None
    keyword: str | None = None
    limit: int = DEFAULT_LIMIT


@dataclass
class LookupResult:
    table: str
    label: str
    rows: list[dict]
    total_matched: int
    source: str
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        payload = {
            "table": self.table,
            "label": self.label,
            "returned": len(self.rows),
            "total_matched": self.total_matched,
            "source": self.source,
            "rows": self.rows,
        }
        if self.total_matched > len(self.rows):
            payload["truncated"] = True
        if self.notes:
            payload["notes"] = self.notes
        return payload


def validate_lookup(raw: dict) -> LookupQuery:
    if not isinstance(raw, dict):
        raise MetricError("查詢參數必須是物件。")

    table = str(raw.get("table") or "").strip()
    if table not in TABLES:
        raise MetricError(
            f"不支援的 table「{table}」。可用：{', '.join(sorted(TABLES))}。"
        )

    district = raw.get("district")
    district = str(district).strip() if district not in (None, "") else None
    if district is not None:
        districts = known_districts()
        if districts and district not in districts:
            raise MetricError(
                f"沒有「{district}」這個行政區。請用 list_available_data 查看可用清單。"
            )

    keyword = raw.get("keyword")
    keyword = str(keyword).strip() if keyword not in (None, "") else None
    if keyword is not None and len(keyword) > 50:
        raise MetricError("keyword 太長，請控制在 50 字以內。")

    # 跟 metrics.py 同樣的陷阱：limit=0 是 falsy，不能用 `or DEFAULT`
    raw_limit = raw.get("limit")
    if raw_limit in (None, ""):
        limit = DEFAULT_LIMIT
    else:
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError):
            raise MetricError("limit 必須是整數。")
    if limit < 1 or limit > MAX_LIMIT:
        raise MetricError(f"limit 必須介於 1 到 {MAX_LIMIT}。")

    return LookupQuery(table=table, district=district, keyword=keyword, limit=limit)


def _trim(row: dict, columns: tuple[str, ...]) -> dict:
    out = {}
    for column in columns:
        value = row.get(column)
        if isinstance(value, str) and len(value) > MAX_FIELD_CHARS:
            value = value[:MAX_FIELD_CHARS] + "…"
        out[column] = value
    return out


# --------------------------------------------------------------------------
# 本機檔案後端
# --------------------------------------------------------------------------
class LocalRecordStore:
    name = "local-records"
    # key -> (mtime, payload, 是否墊底版本)
    _cache: dict[str, tuple[float, dict, bool]] = {}

    def _load(self, table: str) -> tuple[dict, bool]:
        """讀名冊，並以 mtime 判斷是否要重讀。

        快取一定要跟 mtime 綁：每月更新是外部行程覆寫檔案，如果只用
        「載入過就不再讀」的快取，正在跑的容器會一直回舊資料直到重啟 ——
        而重啟不會發生，因為部署沒有變。
        """
        path, bundled = resolve_records_path(table)
        if not path.exists():
            raise MetricError(
                f"找不到名冊資料 {table}.json（已找過 {RECORDS_DIR} 與 "
                f"{BUNDLED_RECORDS_DIR}）。請執行 fetch_sources.py。"
            )

        mtime = path.stat().st_mtime
        cached = self._cache.get(table)
        if cached and cached[0] == mtime:
            return cached[1], cached[2]

        payload = json.loads(path.read_text(encoding="utf-8"))
        self._cache[table] = (mtime, payload, bundled)
        logger.info(
            "loaded %s from %s (%s rows, generated_at=%s)",
            table, path, payload.get("row_count"), payload.get("generated_at"),
        )
        return payload, bundled

    def query(self, q: LookupQuery) -> LookupResult:
        definition = TABLES[q.table]
        payload, bundled = self._load(q.table)
        rows = payload.get("rows") or []

        if q.district:
            rows = [r for r in rows if r.get("district") == q.district]
        if q.keyword:
            needle = q.keyword.lower()
            rows = [
                r for r in rows
                if any(needle in str(r.get(col) or "").lower() for col in definition.searchable)
            ]

        total = len(rows)
        notes = []
        generated = payload.get("generated_at")
        if generated:
            notes.append(f"資料抓取時間 {generated}")
        if bundled:
            # 讓模型和使用者知道這是隨程式打包的版本，不是最近一次更新的結果
            notes.append("此表尚未執行過資料更新，使用的是隨程式打包的版本。")

        return LookupResult(
            table=q.table,
            label=definition.label,
            rows=[_trim(r, definition.columns) for r in rows[: q.limit]],
            total_matched=total,
            source=self.name,
            notes=notes,
        )


# --------------------------------------------------------------------------
# Athena 後端
# --------------------------------------------------------------------------
class AthenaRecordStore:
    name = "athena"

    def __init__(self):
        import boto3

        self._client = boto3.client("athena", config=config.boto_config(ATHENA_TIMEOUT_SECONDS))

    def query(self, q: LookupQuery) -> LookupResult:
        import time

        definition = TABLES[q.table]
        if not ATHENA_OUTPUT:
            raise MetricError("ATHENA_OUTPUT_LOCATION 未設定，無法執行 Athena 查詢。")

        sql, params = self._build_sql(q, definition)
        logger.info("athena records sql=%s params=%s", sql, params)

        start = self._client.start_query_execution(
            QueryString=sql,
            QueryExecutionContext={"Database": ATHENA_DATABASE},
            ResultConfiguration={"OutputLocation": ATHENA_OUTPUT},
            WorkGroup=ATHENA_WORKGROUP,
            **({"ExecutionParameters": params} if params else {}),
            ResultReuseConfiguration={
                "ResultReuseByAgeConfiguration": {"Enabled": True, "MaxAgeInMinutes": 60}
            },
        )
        execution_id = start["QueryExecutionId"]

        deadline = time.time() + ATHENA_TIMEOUT_SECONDS
        while True:
            info = self._client.get_query_execution(QueryExecutionId=execution_id)["QueryExecution"]
            state = info["Status"]["State"]
            if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
                if state != "SUCCEEDED":
                    raise MetricError(
                        f"Athena 查詢失敗：{info['Status'].get('StateChangeReason', state)}"
                    )
                break
            if time.time() > deadline:
                self._client.stop_query_execution(QueryExecutionId=execution_id)
                raise MetricError(f"Athena 查詢超過 {ATHENA_TIMEOUT_SECONDS} 秒，已取消。")
            time.sleep(0.4)

        result = self._client.get_query_results(
            QueryExecutionId=execution_id, MaxResults=min(q.limit + 1, 1000)
        )
        rows = self._parse_rows(result)
        return LookupResult(
            table=q.table,
            label=definition.label,
            rows=rows,
            total_matched=len(rows),
            source=self.name,
        )

    def _build_sql(self, q: LookupQuery, definition: RecordTable) -> tuple[str, list[str]]:
        # 欄位與表名都來自本模組的白名單，不是模型輸入。識別字一律加雙引號，
        # 因為 year/date 這類名稱在 Trino 是函式名。
        select = ", ".join(f'"{column}"' for column in definition.columns)

        where_parts = []
        params: list[str] = []
        if q.district:
            where_parts.append('"district" = ?')
            params.append(q.district)
        if q.keyword:
            # 關鍵字比對哪些欄位由白名單決定，模型只提供要找的字。
            ors = " OR ".join(f'lower("{col}") LIKE ?' for col in definition.searchable)
            where_parts.append(f"({ors})")
            params.extend([f"%{q.keyword.lower()}%"] * len(definition.searchable))

        where_sql = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""
        return (
            f'SELECT {select} FROM "{definition.athena_table}"{where_sql} '
            f'ORDER BY "district", "{definition.columns[1]}" '
            f"LIMIT {int(q.limit)}",
            params,
        )

    @staticmethod
    def _parse_rows(result: dict) -> list[dict]:
        raw_rows = result.get("ResultSet", {}).get("Rows", [])
        if not raw_rows:
            return []
        header = [c.get("VarCharValue", "") for c in raw_rows[0].get("Data", [])]
        parsed = []
        for row in raw_rows[1:]:
            values = [c.get("VarCharValue") for c in row.get("Data", [])]
            parsed.append(dict(zip(header, values)))
        return parsed


_local_store = LocalRecordStore()
_athena_store: AthenaRecordStore | None = None


def run_record_lookup(raw: dict) -> dict:
    q = validate_lookup(raw)

    if METRIC_BACKEND == "athena":
        global _athena_store
        try:
            if _athena_store is None:
                _athena_store = AthenaRecordStore()
            return _athena_store.query(q).to_dict()
        except MetricError:
            raise
        except Exception as error:  # noqa: BLE001
            logger.warning("Athena unavailable for records, falling back: %s", error)
            result = _local_store.query(q)
            result.notes.append(f"Athena 無法使用（{error}），改用本機名冊快照。")
            return result.to_dict()

    return _local_store.query(q).to_dict()


def describe_tables() -> list[dict]:
    return [
        {
            "table": definition.key,
            "label": definition.label,
            "description": definition.description,
            "columns": list(definition.columns),
            "keyword_searches": list(definition.searchable),
        }
        for definition in TABLES.values()
    ]


def freshness() -> list[dict]:
    """每個表的資料時點與筆數，讓「多久沒更新」看得見而不必去翻檔案。"""
    out = []
    for table in TABLES:
        path, bundled = resolve_records_path(table)
        entry: dict = {"table": table, "bundled_fallback": bundled}
        if not path.exists():
            entry["status"] = "missing"
            out.append(entry)
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            entry.update(
                status="ok",
                generated_at=payload.get("generated_at"),
                row_count=payload.get("row_count"),
                # 更新頻率由抓取時寫進檔案（見 fetch.py 的 REFRESH_LABELS），
                # 這裡只是轉出去。不在這裡重新查 data_sources.yaml 是刻意的：
                # 檔案裡的值代表「這份資料實際是用哪個頻率抓的」，而 yaml 是
                # 「現在設定成什麼」。改了排程之後兩者會有一段時間不同，
                # 而畫面上該顯示的是前者。
                refresh_group=payload.get("refresh_group"),
                cadence=payload.get("cadence"),
                refresh_label=payload.get("refresh_label"),
            )
        except (json.JSONDecodeError, OSError) as error:
            entry.update(status="unreadable", error=str(error))
        out.append(entry)
    return out
