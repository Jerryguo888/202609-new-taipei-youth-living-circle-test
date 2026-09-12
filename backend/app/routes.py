"""不需要模型的資料端點：健康檢查、資料目錄、指標、逐筆名冊。

這幾個端點刻意跟 AI 的工具走同一條 `dispatch` 路徑，而不是各自查一次資料。
兩邊各算一次的話，聊天室講的數字和畫面上畫的數字遲早會對不起來，而那種
不一致很難察覺 —— 兩個數字看起來都很合理。
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app import config
from app.ai.tools import TOOL_NAMES, dispatch

router = APIRouter()


@router.get("/api/health")
def health():
    """容器 healthcheck 用，故意不呼叫 AWS，才能反映服務本身活著。"""
    return {
        "status": "ok",
        "region": config.AWS_REGION,
        "model": config.MODEL_ID,
        "knowledgeBase": bool(config.KNOWLEDGE_BASE_ID),
        "tools": TOOL_NAMES if config.ENABLE_TOOLS else [],
        "metricBackend": config.METRIC_BACKEND,
    }


@router.get("/api/meta/datasets")
def meta_datasets():
    """資料目錄：前端和人都可以看目前有哪些指標、行政區、年度與快照時點。"""
    return dispatch("list_available_data", {}, {})[0]


@router.get("/api/records/{table}")
def records_endpoint(
    table: str,
    district: str | None = None,
    keyword: str | None = None,
    limit: int = 10,
):
    """逐筆名冊端點，與 AI 的 lookup_records 走同一條路徑。"""
    result, is_error = dispatch(
        "lookup_records",
        {"table": table, "district": district, "keyword": keyword, "limit": limit},
        {},
    )
    if is_error:
        return JSONResponse(status_code=400, content=result)
    return result


@router.get("/api/metrics/{metric}")
def metrics_endpoint(
    metric: str,
    by: str = "district",
    year: str | None = None,
    district: str | None = None,
    age_band: str = "20-29",
    order: str = "desc",
    limit: int = 10,
):
    """給前端圖表用的數值端點，與 AI 的 query_metrics 走同一條路徑。"""
    result, is_error = dispatch(
        "query_metrics",
        {
            "metric": metric,
            "by": by,
            "year": year,
            "district": district,
            "age_band": age_band,
            "order": order,
            "limit": limit,
        },
        {},
    )
    if is_error:
        return JSONResponse(status_code=400, content=result)
    return result
