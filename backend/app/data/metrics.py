"""數值指標查詢層。

安全性上最重要的一條：**模型不能寫 SQL**。

模型只能填 metric / by / year / district / age_band / order / limit 這些欄位，
而且每個欄位都對照白名單驗證過；SQL 由這裡用固定樣板組出來，過濾值一律走
Athena 的 ExecutionParameters（等同 prepared statement）而不是字串拼接。

理由：模型讀得到 S3 知識庫，知識庫內容是不可信輸入。只要有人塞一份帶提示注入
的文件進去，放行自由 SQL 就同時開了資料外洩和無上限的 Athena 帳單兩個洞。

兩種後端：
    local   讀 curated/metrics_snapshot.json，沒有 AWS 也能跑，延遲近乎零
    athena  真的查 S3 curated 層，支援跨季比較與細粒度切片

athena 失敗時會退回 local 並在結果裡標明，讓模型知道自己拿到的是快照。
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

from app import config

logger = logging.getLogger("living-circle-chat.metrics")

# 路徑與後端設定集中在 app.config，這裡只取用。
SNAPSHOT_PATH = config.BUNDLED_SNAPSHOT_PATH
LIVE_SNAPSHOT_PATH = config.LIVE_SNAPSHOT_PATH
METRIC_BACKEND = config.METRIC_BACKEND
AWS_REGION = config.AWS_REGION
ATHENA_DATABASE = config.ATHENA_DATABASE
ATHENA_WORKGROUP = config.ATHENA_WORKGROUP
ATHENA_OUTPUT = config.ATHENA_OUTPUT
ATHENA_TIMEOUT_SECONDS = config.ATHENA_TIMEOUT_SECONDS

MAX_LIMIT = 30
ORDERS = ("desc", "asc")
AGE_BANDS = ("20-29", "30-34", "20-34")


class MetricError(ValueError):
    """給模型看的錯誤：訊息會原樣回到 toolResult，所以要寫得能讓它自我修正。"""


@dataclass(frozen=True)
class MetricDef:
    key: str
    label: str
    unit: str
    dimensions: tuple[str, ...]
    description: str
    athena_table: str = ""
    # 每個 metric 允許的數值運算式，鍵是 age_band（沒有分年齡層的用 "default"）。
    # 這是白名單，模型碰不到。
    athena_value_sql: dict[str, str] = field(default_factory=dict)
    supports_year: bool = False


METRICS: dict[str, MetricDef] = {
    "youth_population": MetricDef(
        key="youth_population",
        label="青年人口",
        unit="人",
        dimensions=("district", "year", "age_band"),
        description="各行政區 20~29／30~34／20~34 歲人口，2000 年起逐年。",
        athena_table="population_youth",
        athena_value_sql={
            "20-29": "SUM(age_20_29)",
            "30-34": "SUM(age_30_34)",
            "20-34": "SUM(age_20_29 + age_30_34)",
        },
        supports_year=True,
    ),
    "childcare_facilities": MetricDef(
        key="childcare_facilities",
        label="托育機構數量",
        unit="間",
        dimensions=("district",),
        description=(
            "各行政區公共托育中心與私立托嬰機構的「機構數量」。"
            "注意這不是可收托人數，不要當成容額。目前只涵蓋 21 個行政區。"
        ),
        athena_table="childcare_facilities",
        athena_value_sql={"default": "COUNT(*)"},
    ),
    "childcare_pressure": MetricDef(
        key="childcare_pressure",
        label="每間托育機構對應的 20~29 歲人口",
        unit="人/間",
        dimensions=("district",),
        description=(
            "以機構數推估的托育壓力指標，數字越大越稀缺。"
            "這是推估值而非實際容額缺口。"
        ),
        athena_table="childcare_pressure",
        athena_value_sql={"default": "MAX(youth_per_center)"},
    ),
}


@dataclass
class MetricQuery:
    metric: str
    by: str = "district"
    year: str | None = None
    district: str | None = None
    age_band: str = "20-29"
    order: str = "desc"
    limit: int = 10


@dataclass
class MetricResult:
    metric: str
    label: str
    unit: str
    rows: list[dict]
    snapshot: str
    source: str
    notes: list[str] = field(default_factory=list)
    scanned_bytes: int | None = None

    def to_dict(self) -> dict:
        payload = {
            "metric": self.metric,
            "label": self.label,
            "unit": self.unit,
            "snapshot": self.snapshot,
            "source": self.source,
            "row_count": len(self.rows),
            "rows": self.rows,
        }
        if self.notes:
            payload["notes"] = self.notes
        if self.scanned_bytes is not None:
            payload["scanned_bytes"] = self.scanned_bytes
        return payload


# --------------------------------------------------------------------------
# 快照
# --------------------------------------------------------------------------

# (mtime, payload)
_snapshot_cache: tuple[float, dict] | None = None


def resolve_snapshot_path() -> Path:
    return LIVE_SNAPSHOT_PATH if LIVE_SNAPSHOT_PATH.exists() else SNAPSHOT_PATH


def load_snapshot() -> dict:
    """讀指標快照，以 mtime 判斷是否重讀。

    跟名冊同樣的理由：更新是外部行程覆寫檔案，永久快取會讓執行中的容器
    一直回舊資料，而且不會有任何跡象。
    """
    global _snapshot_cache
    path = resolve_snapshot_path()
    if not path.exists():
        raise MetricError(
            f"找不到指標快照（已找過 {LIVE_SNAPSHOT_PATH} 與 {SNAPSHOT_PATH}），"
            "無法查詢數值。請先執行 build_snapshot.py。"
        )
    mtime = path.stat().st_mtime
    if _snapshot_cache is not None and _snapshot_cache[0] == mtime:
        return _snapshot_cache[1]
    payload = json.loads(path.read_text(encoding="utf-8"))
    _snapshot_cache = (mtime, payload)
    logger.info("loaded metrics snapshot from %s (snapshot=%s)", path, payload.get("snapshot"))
    return payload


def known_districts() -> list[str]:
    try:
        return list(load_snapshot().get("districts") or [])
    except MetricError:
        return []


def known_years() -> list[str]:
    try:
        return list(load_snapshot().get("years") or [])
    except MetricError:
        return []


# --------------------------------------------------------------------------
# 驗證：模型的輸入全部在這裡收斂成安全的值
# --------------------------------------------------------------------------
def validate_query(raw: dict) -> MetricQuery:
    if not isinstance(raw, dict):
        raise MetricError("查詢參數必須是物件。")

    metric = str(raw.get("metric") or "").strip()
    if metric not in METRICS:
        raise MetricError(
            f"不支援的 metric「{metric}」。可用：{', '.join(sorted(METRICS))}。"
        )
    definition = METRICS[metric]

    by = str(raw.get("by") or "district").strip()
    if by not in definition.dimensions:
        raise MetricError(
            f"{metric} 不支援用「{by}」分組。可用：{', '.join(definition.dimensions)}。"
        )

    order = str(raw.get("order") or "desc").strip().lower()
    if order not in ORDERS:
        raise MetricError("order 只能是 desc 或 asc。")

    # 不能寫 `raw.get("limit") or 10`：limit=0 是 falsy，會被悄悄換成 10，
    # 等於把一個不合法的值當成預設值接受。要先分辨「沒給」和「給了 0」。
    raw_limit = raw.get("limit")
    if raw_limit in (None, ""):
        limit = 10
    else:
        try:
            limit = int(raw_limit)
        except (TypeError, ValueError):
            raise MetricError("limit 必須是整數。")
    if limit < 1 or limit > MAX_LIMIT:
        raise MetricError(f"limit 必須介於 1 到 {MAX_LIMIT}。")

    age_band = str(raw.get("age_band") or "20-29").strip()
    if age_band not in AGE_BANDS:
        raise MetricError(f"age_band 只能是 {', '.join(AGE_BANDS)}。")

    year = raw.get("year")
    year = str(year).strip() if year not in (None, "") else None
    if year is not None:
        if not definition.supports_year:
            raise MetricError(f"{metric} 沒有年度維度，不要傳 year。")
        years = known_years()
        if years and year not in years:
            raise MetricError(
                f"沒有 {year} 年的資料。可用年度 {years[0]}~{years[-1]}。"
            )

    district = raw.get("district")
    district = str(district).strip() if district not in (None, "") else None
    if district is not None:
        districts = known_districts()
        if districts and district not in districts:
            raise MetricError(
                f"沒有「{district}」這個行政區。請用 list_available_data 查看可用清單。"
            )

    return MetricQuery(
        metric=metric,
        by=by,
        year=year,
        district=district,
        age_band=age_band,
        order=order,
        limit=limit,
    )


# --------------------------------------------------------------------------
# 本機快照後端
# --------------------------------------------------------------------------
AGE_FIELDS = {"20-29": "age20_29", "30-34": "age30_34", "20-34": "age20_34"}


class LocalSnapshotStore:
    name = "local-snapshot"

    def query(self, q: MetricQuery) -> MetricResult:
        snapshot = load_snapshot()
        definition = METRICS[q.metric]
        metric_block = snapshot["metrics"][q.metric]
        notes: list[str] = []
        if metric_block.get("note"):
            notes.append(metric_block["note"])

        if q.metric == "youth_population":
            rows = self._youth(q, metric_block, notes)
        elif q.metric == "childcare_facilities":
            rows = self._childcare(q, metric_block)
        else:
            rows = self._pressure(q, metric_block)

        # value 可能是 None（例如某區沒有托育機構）。缺值一律排到最後，
        # 不論升冪或降冪，否則「最稀缺的區」會被沒資料的區佔位。
        descending = q.order == "desc"

        def sort_key(row):
            value = row.get("value")
            missing = value is None
            magnitude = 0 if missing else value
            return (missing, -magnitude if descending else magnitude)

        rows.sort(key=sort_key)

        return MetricResult(
            metric=q.metric,
            label=definition.label,
            unit=definition.unit,
            rows=rows[: q.limit],
            snapshot=snapshot.get("snapshot", "local"),
            source=self.name,
            notes=notes,
        )

    def _youth(self, q: MetricQuery, block: dict, notes: list[str]) -> list[dict]:
        by_year = block["by_year"]
        field_name = AGE_FIELDS[q.age_band]

        if q.by == "year":
            # 時間序列：固定一個行政區，看逐年變化
            area = q.district or "新北市"
            rows = []
            for year, districts in by_year.items():
                entry = districts.get(area)
                if entry is None and area == "新北市":
                    entry = block["city_totals"].get(year)
                if entry:
                    rows.append({"year": year, "district": area, "value": entry[field_name]})
            notes.append(f"年度序列，行政區＝{area}，年齡層＝{q.age_band}")
            return rows

        if q.by == "age_band":
            year = q.year or load_snapshot()["latest_year"]
            area = q.district or "新北市"
            source = by_year.get(year, {}).get(area) or block["city_totals"].get(year, {})
            return [
                {"age_band": band, "district": area, "year": year, "value": source.get(AGE_FIELDS[band])}
                for band in AGE_BANDS
            ]

        year = q.year or load_snapshot()["latest_year"]
        notes.append(f"年度＝{year}，年齡層＝{q.age_band}")
        districts = by_year.get(year, {})
        items = districts.items()
        if q.district:
            items = [(q.district, districts.get(q.district, {}))]
        return [
            {"district": area, "year": year, "value": entry.get(field_name)}
            for area, entry in items
            if entry
        ]

    def _childcare(self, q: MetricQuery, block: dict) -> list[dict]:
        by_district = block["by_district"]
        items = by_district.items()
        if q.district:
            items = [(q.district, by_district.get(q.district, {}))]
        return [
            {
                "district": area,
                "value": counts.get("total_centers"),
                "public_centers": counts.get("public_centers"),
                "private_centers": counts.get("private_centers"),
            }
            for area, counts in items
            if counts
        ]

    def _pressure(self, q: MetricQuery, block: dict) -> list[dict]:
        by_district = block["by_district"]
        items = by_district.items()
        if q.district:
            items = [(q.district, by_district.get(q.district, {}))]
        return [
            {
                "district": area,
                "value": row.get("youth_per_center"),
                "youth_20_29": row.get("youth_20_29"),
                "total_centers": row.get("total_centers"),
            }
            for area, row in items
            if row
        ]


# --------------------------------------------------------------------------
# Athena 後端
# --------------------------------------------------------------------------
class AthenaStore:
    name = "athena"

    def __init__(self):
        import boto3  # 延後 import，local 模式不需要付這個成本

        self._client = boto3.client("athena", config=config.boto_config(ATHENA_TIMEOUT_SECONDS))

    def query(self, q: MetricQuery) -> MetricResult:
        definition = METRICS[q.metric]
        if not ATHENA_OUTPUT:
            raise MetricError("ATHENA_OUTPUT_LOCATION 未設定，無法執行 Athena 查詢。")

        sql, params = self._build_sql(q, definition)
        logger.info("athena sql=%s params=%s", sql, params)

        start = self._client.start_query_execution(
            QueryString=sql,
            QueryExecutionContext={"Database": ATHENA_DATABASE},
            ResultConfiguration={"OutputLocation": ATHENA_OUTPUT},
            WorkGroup=ATHENA_WORKGROUP,
            # 過濾值走 prepared statement，不進 SQL 字串
            **({"ExecutionParameters": params} if params else {}),
            # 相同查詢在一小時內重用結果，季度資料完全不需要每次重掃
            ResultReuseConfiguration={
                "ResultReuseByAgeConfiguration": {"Enabled": True, "MaxAgeInMinutes": 60}
            },
        )
        execution_id = start["QueryExecutionId"]

        deadline = time.time() + ATHENA_TIMEOUT_SECONDS
        scanned = None
        while True:
            info = self._client.get_query_execution(QueryExecutionId=execution_id)["QueryExecution"]
            state = info["Status"]["State"]
            scanned = info.get("Statistics", {}).get("DataScannedInBytes")
            if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
                if state != "SUCCEEDED":
                    reason = info["Status"].get("StateChangeReason", state)
                    raise MetricError(f"Athena 查詢失敗：{reason}")
                break
            if time.time() > deadline:
                self._client.stop_query_execution(QueryExecutionId=execution_id)
                raise MetricError(f"Athena 查詢超過 {ATHENA_TIMEOUT_SECONDS} 秒，已取消。")
            time.sleep(0.4)

        result = self._client.get_query_results(QueryExecutionId=execution_id, MaxResults=q.limit + 1)
        rows = self._parse_rows(result)

        return MetricResult(
            metric=q.metric,
            label=definition.label,
            unit=definition.unit,
            rows=rows,
            snapshot=q.year or "latest",
            source=self.name,
            scanned_bytes=scanned,
        )

    def _build_sql(self, q: MetricQuery, definition: MetricDef) -> tuple[str, list[str]]:
        """SQL 完全由白名單組成，只有過濾值用參數帶入。"""
        value_sql = definition.athena_value_sql.get(q.age_band) or definition.athena_value_sql.get("default")
        if not value_sql:
            raise MetricError(f"{q.metric} 不支援 age_band={q.age_band}。")

        group_column = {"district": "district", "year": "year", "age_band": "district"}[q.by]

        # 識別字（表名、欄名、聚合式、排序方向）都來自本模組的常數，
        # 不是來自模型輸入，所以直接內插是安全的。
        where_parts = []
        params: list[str] = []
        if q.year and definition.supports_year:
            where_parts.append('"year" = ?')
            params.append(q.year)
        if q.district:
            where_parts.append('"district" = ?')
            params.append(q.district)

        where_sql = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""
        # 識別字一律加雙引號。`year` 在 Trino／Athena 是函式名稱，不加引號當欄位名
        # 用會踩到保留字問題；加了引號就不必逐個判斷哪些字安全。
        # 這些值全部來自本模組常數，不是模型輸入，所以內插是安全的。
        return (
            f'SELECT "{group_column}" AS dimension, {value_sql} AS value '
            f'FROM "{definition.athena_table}"{where_sql} '
            f'GROUP BY "{group_column}" '
            f"ORDER BY value {q.order.upper()} NULLS LAST "
            f"LIMIT {int(q.limit)}",
            params,
        )

    @staticmethod
    def _parse_rows(result: dict) -> list[dict]:
        result_set = result.get("ResultSet", {})
        raw_rows = result_set.get("Rows", [])
        if not raw_rows:
            return []
        header = [c.get("VarCharValue", "") for c in raw_rows[0].get("Data", [])]
        parsed = []
        for row in raw_rows[1:]:
            values = [c.get("VarCharValue") for c in row.get("Data", [])]
            record = dict(zip(header, values))
            raw_value = record.get("value")
            try:
                record["value"] = float(raw_value) if raw_value is not None else None
                if record["value"] is not None and record["value"].is_integer():
                    record["value"] = int(record["value"])
            except (TypeError, ValueError):
                pass
            if "dimension" in record:
                record["district"] = record.pop("dimension")
            parsed.append(record)
        return parsed


# --------------------------------------------------------------------------
# 對外入口
# --------------------------------------------------------------------------
_local_store = LocalSnapshotStore()
_athena_store: AthenaStore | None = None


def run_metric_query(raw: dict) -> dict:
    """驗證 + 執行，回傳可以直接放進 toolResult 的 dict。"""
    q = validate_query(raw)

    if METRIC_BACKEND == "athena":
        global _athena_store
        try:
            if _athena_store is None:
                _athena_store = AthenaStore()
            return _athena_store.query(q).to_dict()
        except MetricError:
            raise
        except Exception as error:  # noqa: BLE001
            # Athena 不通時不要讓整個回答失敗，退回快照並老實說明來源，
            # 模型才知道自己引用的是快取而不是即時查詢。
            logger.warning("Athena unavailable, falling back to snapshot: %s", error)
            result = _local_store.query(q)
            result.notes.append(f"Athena 無法使用（{error}），改用本機指標快照。")
            return result.to_dict()

    return _local_store.query(q).to_dict()


def describe_metrics() -> list[dict]:
    return [
        {
            "metric": definition.key,
            "label": definition.label,
            "unit": definition.unit,
            "dimensions": list(definition.dimensions),
            "description": definition.description,
            "supports_year": definition.supports_year,
        }
        for definition in METRICS.values()
    ]
