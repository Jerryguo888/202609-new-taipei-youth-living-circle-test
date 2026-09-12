"""讀 data_sources.yaml —— 「有哪些資料、從哪來、多久更新、進到哪裡」的單一事實來源。

刻意讓兩件事共用同一個檔案：
  - 每月更新作業決定要抓哪些 API
  - `list_available_data` 工具告訴模型有哪些資料可用

各自維護一份的話，改了一邊沒改另一邊，模型就會以為某份資料還在（或不在），
而這種錯誤在回答裡看不出來。
"""

from __future__ import annotations

import logging

import yaml

from app import config

logger = logging.getLogger("living-circle-chat.registry")

_cache: dict | None = None


def load_raw() -> dict:
    """讀原始 YAML；解析失敗回空結構並記錄，不要讓後端起不來。"""
    global _cache
    if _cache is not None:
        return _cache

    path = config.DATA_SOURCES_PATH
    if not path.exists():
        logger.warning("找不到 %s", path)
        _cache = {}
        return _cache
    try:
        _cache = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as error:
        logger.error("%s 不是合法的 YAML：%s", path, error)
        _cache = {}
    return _cache


def datasets() -> list[dict]:
    return load_raw().get("datasets") or []


def dataset(dataset_id: str) -> dict | None:
    for entry in datasets():
        if entry.get("id") == dataset_id:
            return entry
    return None


def catalogue() -> list[dict]:
    """給模型看的簡化版目錄。"""
    out = []
    for entry in datasets():
        destinations = entry.get("destination") or []
        out.append(
            {
                "id": entry.get("id"),
                "name": entry.get("name"),
                "cadence": entry.get("cadence"),
                # 讓模型知道這份資料查得到數字、還是只能語意檢索
                "queryable_as_metric": "athena" in destinations,
                "searchable_in_kb": "kb" in destinations,
                "updated_by": "自動抓取 API" if entry.get("fetch") == "api" else "人工季度上傳",
            }
        )
    return out
