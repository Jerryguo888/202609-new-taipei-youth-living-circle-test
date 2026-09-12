"""模型可以自己選用的工具（Bedrock Converse tool use）。

設計重點是「讓 AI 自己決定要讀哪些資料」，所以刻意分成四個工具：

    list_available_data  先看有哪些資料集、指標、行政區、年度可用
    query_metrics        要數字時走這裡（S3 curated / Athena，或本機快照）
    lookup_records       要逐筆名冊（機構、地址、電話、時段）時走這裡
    search_documents     要文字說明、政策、報表時走這裡（S3 知識庫）

為什麼把知識庫也做成工具、而不是每次都先檢索一遍：
  1. 問「板橋區青年人口多少」不需要語意檢索，先撈一堆文字只會干擾判斷；
  2. 數值題走 KB 本來就會答錯 —— 向量檢索沒辦法排序或加總，
     模型只能從撈回的片段裡猜一個看起來合理的數字；
  3. 讓模型自己選，才有辦法在 UI 上老實顯示「這個答案讀了哪些資料」。
"""

from __future__ import annotations

import json
import logging

from app.data import registry
from app.data.metrics import (
    METRICS,
    describe_metrics,
    known_districts,
    known_years,
    load_snapshot,
    MetricError,
    run_metric_query,
)
from app.data.records import (
    MAX_LIMIT as RECORDS_MAX_LIMIT,
    TABLES,
    describe_tables,
    freshness,
    run_record_lookup,
)

logger = logging.getLogger("living-circle-chat.tools")


# 每個工具的 JSON Schema。additionalProperties=False 讓模型亂加欄位時
# 直接被 Bedrock 擋掉，不必等到我們自己驗證。
TOOL_SPECS = [
    {
        "toolSpec": {
            "name": "list_available_data",
            "description": (
                "列出目前可查的資料：指標清單、每個指標支援的維度、行政區清單、"
                "年度範圍，以及知識庫涵蓋的主題。"
                "不確定有沒有某項資料時先呼叫這個，不要憑印象猜。"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "query_metrics",
            "description": (
                "查詢結構化數值：排名、比較、加總、逐年變化。"
                "任何要講出具體數字的情況都必須先呼叫這個工具，不可以自己估算或憑記憶回答。"
                "回傳值已經排序並截斷，可以直接拿來畫圖表。"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "metric": {
                            "type": "string",
                            "enum": sorted(METRICS.keys()),
                            "description": "要查哪個指標。用 list_available_data 看說明。",
                        },
                        "by": {
                            "type": "string",
                            "enum": ["district", "year", "age_band"],
                            "description": "分組維度，預設 district。看逐年變化用 year。",
                        },
                        "year": {
                            "type": "string",
                            "description": "西元年，例如 2024。只有 youth_population 支援。省略則用最新年度。",
                        },
                        "district": {
                            "type": "string",
                            "description": "限定單一行政區，例如 板橋區。省略則查全部。",
                        },
                        "age_band": {
                            "type": "string",
                            "enum": ["20-29", "30-34", "20-34"],
                            "description": "年齡層，預設 20-29。",
                        },
                        "order": {
                            "type": "string",
                            "enum": ["desc", "asc"],
                            "description": "排序方向，預設 desc。找最稀缺的用 desc 配 childcare_pressure。",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "回傳幾列，1~30，預設 10。",
                        },
                    },
                    "required": ["metric"],
                    "additionalProperties": False,
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "lookup_records",
            "description": (
                "查逐筆名冊：托育機構、疫苗接種院所、衛生所接種時段、YouBike 站點。"
                "要回答「某區有哪些機構」、「地址電話是什麼」、「哪些診所有自費疫苗」"
                "這類問題時用這個，不要用 search_documents —— 名冊是結構化資料，"
                "用語意檢索會混進其他行政區的資料，地址也可能被改寫錯。"
                "回傳值裡的地址與電話請原樣引用，不要改寫。"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "table": {
                            "type": "string",
                            "enum": sorted(TABLES.keys()),
                            "description": "要查哪份名冊。用 list_available_data 看各表說明。",
                        },
                        "district": {
                            "type": "string",
                            "description": "限定行政區，例如 板橋區。省略則查全部。",
                        },
                        "keyword": {
                            "type": "string",
                            "description": (
                                "關鍵字，會比對名稱、地址等欄位（各表可比對的欄位固定）。"
                                "例如查自費疫苗可用「自費」。50 字以內。"
                            ),
                        },
                        "limit": {
                            "type": "integer",
                            "description": f"回傳幾筆，1~{RECORDS_MAX_LIMIT}，預設 10。",
                        },
                    },
                    "required": ["table"],
                    "additionalProperties": False,
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "search_documents",
            "description": (
                "在 S3 知識庫做語意檢索。知識庫裡**只有**人工上傳的統計報表與"
                "政策說明文件（例如主計處的接種數／應接種數統計）。"
                "機構名冊、地址、時段不在知識庫裡，那些要用 lookup_records；"
                "數字與排名要用 query_metrics。"
            ),
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "檢索關鍵句，用完整的自然語言描述要找什麼。",
                        },
                        "top_k": {
                            "type": "integer",
                            "description": "取幾個片段，1~10，預設 5。",
                        },
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                }
            },
        }
    },
]

TOOL_NAMES = [spec["toolSpec"]["name"] for spec in TOOL_SPECS]


def _list_available_data(_payload: dict, _context: dict) -> dict:
    try:
        snapshot = load_snapshot()
        snapshot_id = snapshot.get("snapshot", "unknown")
        generated_at = snapshot.get("generated_at")
    except MetricError as error:
        snapshot_id, generated_at = "unavailable", None
        logger.warning("snapshot unavailable: %s", error)

    years = known_years()
    return {
        "snapshot": snapshot_id,
        "generated_at": generated_at,
        "metrics": describe_metrics(),
        # 逐筆名冊，走 lookup_records
        "record_tables": describe_tables(),
        # 每個表的資料時點，讓模型能說出「依 X 月抓取的資料」
        "data_freshness": freshness(),
        "districts": known_districts(),
        "year_range": {"from": years[0], "to": years[-1]} if years else None,
        # 直接來自 data_sources.yaml，不另外維護一份清單
        "datasets": registry.catalogue(),
        "caveats": [
            "托育機構資料目前只涵蓋 21 個行政區，其餘 8 區沒有統計。",
            "childcare_facilities 指標是機構數量，不是可收托人數。",
            "childcare_pressure 是以機構數推估的壓力指標，不等於容額缺口。",
            "知識庫只有人工上傳的統計報表與政策文件；機構名冊要用 lookup_records。",
            "只有私立托嬰機構有 capacity（核定收托人數），公共托育中心沒有。",
        ],
    }


def _query_metrics(payload: dict, _context: dict) -> dict:
    return run_metric_query(payload or {})


def _lookup_records(payload: dict, _context: dict) -> dict:
    return run_record_lookup(payload or {})


def _search_documents(payload: dict, context: dict) -> dict:
    retrieve = context.get("retrieve")
    if retrieve is None:
        return {"error": "知識庫未設定（KNOWLEDGE_BASE_ID 為空），無法檢索文件。"}

    query = str((payload or {}).get("query") or "").strip()
    if not query:
        return {"error": "query 不可為空。"}

    try:
        top_k = int((payload or {}).get("top_k") or 5)
    except (TypeError, ValueError):
        top_k = 5
    top_k = max(1, min(top_k, 10))

    chunks = retrieve(query, top_k)
    if not chunks:
        return {"results": [], "note": "知識庫沒有找到相關內容。"}

    return {
        "results": [
            {
                "uri": chunk.get("uri", ""),
                "score": chunk.get("score", 0),
                # 截斷單一片段，避免一次檢索就把上下文吃光
                "text": (chunk.get("text") or "")[:1500],
            }
            for chunk in chunks
        ]
    }


HANDLERS = {
    "list_available_data": _list_available_data,
    "query_metrics": _query_metrics,
    "lookup_records": _lookup_records,
    "search_documents": _search_documents,
}


def dispatch(name: str, payload: dict, context: dict) -> tuple[dict, bool]:
    """執行工具。

    回傳 (結果, 是否錯誤)。錯誤不會拋出去中斷對話，而是包成 toolResult 回給
    模型，讓它有機會改參數重試 —— 這是 tool use 的正常運作方式。
    """
    handler = HANDLERS.get(name)
    if handler is None:
        return {"error": f"未知的工具「{name}」。可用：{', '.join(TOOL_NAMES)}"}, True

    try:
        return handler(payload or {}, context), False
    except MetricError as error:
        # 驗證錯誤的訊息是刻意寫給模型看的，直接回傳讓它自我修正
        return {"error": str(error)}, True
    except Exception as error:  # noqa: BLE001
        logger.exception("tool %s failed", name)
        return {"error": f"工具執行失敗：{error}"}, True


def summarise_for_ui(name: str, payload: dict) -> str:
    """給前端顯示「AI 讀了什麼」的一行描述。"""
    payload = payload or {}
    if name == "list_available_data":
        return "查看可用資料清單"
    if name == "query_metrics":
        parts = [str(payload.get("metric") or "")]
        if payload.get("district"):
            parts.append(str(payload["district"]))
        if payload.get("year"):
            parts.append(str(payload["year"]) + " 年")
        if payload.get("age_band"):
            parts.append(str(payload["age_band"]) + " 歲")
        return "查詢數值：" + " / ".join(p for p in parts if p)
    if name == "lookup_records":
        parts = [str(payload.get("table") or "")]
        if payload.get("district"):
            parts.append(str(payload["district"]))
        if payload.get("keyword"):
            parts.append("關鍵字「" + str(payload["keyword"])[:20] + "」")
        return "查詢名冊：" + " / ".join(p for p in parts if p)
    if name == "search_documents":
        return "檢索知識庫：" + str(payload.get("query") or "")[:40]
    return name


def json_size(payload: dict) -> int:
    return len(json.dumps(payload, ensure_ascii=False))
