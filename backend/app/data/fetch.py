"""抓取開放資料 API 並正規化成逐筆記錄。

這支是**函式庫**：後台的「立即更新」按鈕和 scripts/fetch_sources.py 兩邊都呼叫
`fetch_all()`，所以只有一份實作。CLI 的參數解析在 scripts/ 裡。

用途：`lookup_records` 工具要回答「板橋區有哪些公共托育中心」這種逐筆查詢。
這類名冊資料**不進知識庫** —— 向量檢索比的是語意相似度而不是欄位相等，問板橋
很容易撈回新莊的片段；而地址電話經過 embedding 再讓模型重述，是最容易產生幻覺
的地方。改成結構化查詢就沒有這兩個問題。
"""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from app import config
from app.data import registry

logger = logging.getLogger("living-circle-chat.fetch")

USER_AGENT = "ntpc-youth-living-circle/1.0 (+quarterly refresh)"
TIMEOUT_SECONDS = 60

_district_stems: list[str] | None = None


def district_stems() -> list[str]:
    """從指標快照拿權威的 29 個行政區名，去掉「區」字當比對詞幹。

    不要用 r"([\u4e00-\u9fff]{1,4}區)" 這種正規表示式：它在「新北市板橋區」上
    會貪心地 match 到「北市板橋區」，實測會產生 38 個不存在的行政區。改成拿已知
    清單去比對，順便能處理兩種髒資料：
      「新北市汐止市樟樹一路」 2010 升格前的舊名，沒有「區」字
      「新北市三重水漾路1段」  直接省略行政區

    延後載入（不是模組層級常數）：import 這支模組時快照可能還不存在，
    例如在還沒產生快照的環境裡跑測試。
    """
    global _district_stems
    if _district_stems is not None:
        return _district_stems

    path = config.LIVE_SNAPSHOT_PATH if config.LIVE_SNAPSHOT_PATH.exists() else config.BUNDLED_SNAPSHOT_PATH
    if not path.exists():
        raise FetchError(f"找不到指標快照 {path}，無法取得行政區清單。請先執行 build_snapshot.py。")
    districts = json.loads(path.read_text(encoding="utf-8")).get("districts") or []
    if not districts:
        raise FetchError("指標快照裡沒有行政區清單。")
    # 依長度倒序，避免短名先命中造成誤判
    _district_stems = sorted((d[:-1] if d.endswith("區") else d for d in districts), key=len, reverse=True)
    return _district_stems


class FetchError(RuntimeError):
    """抓取或設定問題；CLI 會轉成非零結束碼。"""


def fetch_json(url: str) -> list[dict]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    # data.ntpc.gov.tw 直接回陣列，其他平台可能包一層
    if isinstance(payload, list):
        return payload
    for key in ("data", "result", "records", "items"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            inner = value.get("records") or value.get("results")
            if isinstance(inner, list):
                return inner
    raise ValueError(f"看不懂的回傳格式，最外層鍵：{list(payload)[:10]}")


def clean(value) -> str:
    return str(value or "").strip()


def district_from(*candidates: str) -> str:
    """從多個候選欄位裡找出「XX區」。

    來源欄位很不一致：公共托育中心用 town（「汐止區」），私立托嬰用 area
    （「新北市板橋區」），診所名冊只有完整地址。統一抽出區名，
    抽不到就回空字串而不是猜，讓後續驗證能發現缺漏。
    """
    for candidate in candidates:
        text = clean(candidate)
        if not text:
            continue
        for stem in district_stems():
            if stem in text:
                return stem + "區"
    return ""


def to_int(value) -> int | None:
    text = clean(value).replace(",", "")
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def previous_row_count(path: Path) -> int:
    """讀既有檔案的筆數，用來判斷這次抓的資料是否異常縮水。"""
    if not path.exists():
        return 0
    try:
        return int(json.loads(path.read_text(encoding="utf-8")).get("row_count") or 0)
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        return 0


def to_float(value) -> float | None:
    text = clean(value)
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# 各資料集的正規化
# --------------------------------------------------------------------------
def normalise_childcare_public(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        out.append(
            {
                "district": district_from(row.get("town"), row.get("address")),
                "name": clean(row.get("name")),
                "kind": "公共托育中心",
                "operator": clean(row.get("unit")),
                "address": clean(row.get("address")),
                "phone": clean(row.get("localcallservice")),
                "capacity": None,  # 這份沒有核定人數
            }
        )
    return out


def normalise_childcare_private(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        out.append(
            {
                "district": district_from(row.get("area"), row.get("address")),
                "name": clean(row.get("title")),
                "kind": "私立托嬰機構",
                "operator": "",
                "address": clean(row.get("address")),
                "phone": clean(row.get("localcallservice")),
                # person 是核定收托人數，是唯一帶容額的來源
                "capacity": to_int(row.get("person")),
            }
        )
    return out


def normalise_vaccine_clinics(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        out.append(
            {
                "district": district_from(row.get("address")),
                "name": clean(row.get("name")),
                "address": clean(row.get("address")),
                # 這個欄位名真的有空格，是來源就這樣
                "phone": clean(row.get("telephone number")),
                "clinic_type": clean(row.get("type")),
                "reservation": clean(row.get("reservation")),
                # 來源是「是」／「否」，直接存的話關鍵字搜尋完全無用：使用者和模型
                # 會用「自費」去找，而「是」裡面沒有這兩個字。
                # 改存成有語意的詞，而且刻意選「僅公費」而不是「非自費」——
                # 後者含有「自費」子字串，會讓子字串搜尋把兩種都撈出來。
                "self_paid": "有自費疫苗" if clean(row.get("own_expense")) == "是" else "僅公費疫苗",
                "remark": clean(row.get("remark")),
            }
        )
    return out


def normalise_vaccine_schedules(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        out.append(
            {
                "district": district_from(row.get("district")),
                "vaccine_hours": clean(row.get("vaccine")),
                "bcg_hours": clean(row.get("bcg")),
                "remark": clean(row.get("remark")),
                "updated": clean(row.get("date")),
            }
        )
    return out


def normalise_youbike(rows: list[dict]) -> list[dict]:
    """站點的靜態屬性，加上即時的可借車數。

    `available` 與 `updated` 是即時值。原本刻意丟掉它們，因為當時只有每月一次的
    抓取，存一個「上個月某一刻的可借車數」會變成看起來精確但其實毫無意義的數字。

    現在 YouBike 改成每小時抓一次（.github/workflows/refresh-youbike.yml），
    一小時內的誤差對「哪些站點沒車」這種判斷是可接受的，所以把它們留下來。
    `updated` 是來源自己的時戳（mday，格式 20260913T014500），跟我們的抓取時間
    不同 —— 兩者都要保留，才分得出「我們多久沒抓」和「來源多久沒動」。
    """
    out = []
    for row in rows:
        out.append(
            {
                "district": district_from(row.get("sarea"), row.get("ar")),
                "name": clean(row.get("sna")).replace("YouBike2.0_", ""),
                "station_id": clean(row.get("sno")),
                "address": clean(row.get("ar")),
                "docks": to_int(row.get("tot_quantity")),
                "available": to_int(row.get("sbi_quantity")),
                "updated": clean(row.get("mday")),
                "lat": to_float(row.get("lat")),
                "lon": to_float(row.get("lng")),
            }
        )
    return out


# dataset id -> (輸出的表名, 正規化函式)
# 給人看的更新頻率描述。寫進輸出檔，前端直接顯示，不必自己維護一份對照表
# —— 兩邊各寫一份的話，改了排程忘記改文案，畫面上就會標錯頻率。
REFRESH_LABELS = {
    "monthly": "每月更新",
    "hourly": "每小時更新",
}


NORMALISERS = {
    "ntpc-childcare-public": ("childcare_facilities", normalise_childcare_public),
    "ntpc-childcare-private": ("childcare_facilities", normalise_childcare_private),
    "ntpc-vaccine-clinics": ("vaccine_clinics", normalise_vaccine_clinics),
    "ntpc-vaccine-schedules": ("vaccine_schedules", normalise_vaccine_schedules),
    "ntpc-youbike": ("youbike_stations", normalise_youbike),
}


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def fetch_all(
    out_dir: Path | None = None,
    only: list[str] | None = None,
    max_shrink: float | None = None,
    group: str | None = None,
    log=print,
) -> dict:
    """抓取所有（或指定的）資料表並寫出。

    後台的「立即更新」和 CLI 都走這裡，所以行為完全一致。

    `group` 對應 data_sources.yaml 的 refresh_group：`monthly` 是名冊類，
    `hourly` 只有 YouBike。不指定就全抓（後台按鈕與手動執行用）。

    回傳 {"written": [表名], "problems": [說明], "counts": {表名: 筆數}}。
    """
    out = Path(out_dir) if out_dir else config.RECORDS_DIR
    shrink = config.FETCH_MAX_SHRINK if max_shrink is None else max_shrink
    out.mkdir(parents=True, exist_ok=True)

    tables: dict[str, list[dict]] = {}
    problems: list[str] = []
    # 每個表的更新頻率描述，寫進輸出檔讓前端不必自己維護一份對照表
    table_cadence: dict[str, dict] = {}

    for entry in registry.datasets():
        dataset_id = entry.get("id")
        mapping = NORMALISERS.get(dataset_id)
        if mapping is None:
            continue
        table, normalise = mapping
        if only and table not in only:
            continue
        entry_group = entry.get("refresh_group") or "monthly"
        if group and entry_group != group:
            continue
        # 同一張表可能由多個來源合併（托育 = 公共 + 私立），頻率取第一個就好，
        # 因為同一張表的來源一定在同一個批次裡。
        table_cadence.setdefault(
            table,
            {
                "refresh_group": entry_group,
                "cadence": entry.get("cadence"),
                "refresh_label": REFRESH_LABELS.get(entry_group, entry_group),
            },
        )

        log(f"抓取 {dataset_id} -> {table}")
        try:
            rows = fetch_json(entry.get("url"))
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError) as error:
            problems.append(f"{dataset_id}: {error}")
            log(f"  失敗：{error}")
            continue

        records = normalise(rows)
        missing = sum(1 for r in records if not r.get("district"))
        if missing:
            problems.append(f"{dataset_id}: {missing}/{len(records)} 筆抽不出行政區")
        log(f"  {len(rows)} 筆原始 -> {len(records)} 筆，缺行政區 {missing} 筆")
        tables.setdefault(table, []).extend(records)

    written: list[str] = []
    counts: dict[str, int] = {}

    for table, records in sorted(tables.items()):
        path = out / f"{table}.json"
        previous = previous_row_count(path)

        # 上游掛掉或改格式時，寧可保留上一版也不要用壞資料覆蓋。
        # 每月自動更新的情境下這道關卡很重要：沒有人會盯著每次執行的輸出，
        # 而「名冊突然變成 0 筆」在畫面上看起來就只是「查不到資料」。
        if not records:
            problems.append(f"{table}: 抓到 0 筆，保留既有檔案不覆蓋")
            log(f"  跳過 {table}：0 筆")
            continue
        if previous and len(records) < previous * (1 - shrink):
            problems.append(
                f"{table}: 筆數從 {previous} 掉到 {len(records)}"
                f"（超過 {shrink:.0%} 門檻），保留既有檔案不覆蓋"
            )
            log(f"  跳過 {table}：筆數異常下降 {previous} -> {len(records)}")
            continue

        # 頻率資訊跟資料放在同一個檔案裡，前端讀這一份就同時拿到「資料多新」
        # 與「多久更新一次」，不必另外呼叫端點、也不必自己維護對照表。
        meta = table_cadence.get(table) or {}
        payload = {
            "table": table,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "row_count": len(records),
            "refresh_group": meta.get("refresh_group"),
            "cadence": meta.get("cadence"),
            "refresh_label": meta.get("refresh_label"),
            "rows": records,
        }
        # 先寫暫存檔再 rename：os.replace 在同一個檔案系統上是原子操作，
        # 所以正在跑的後端不會讀到寫一半的 JSON。
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)
        written.append(table)
        counts[table] = len(records)
        delta = f"（上次 {previous} 筆）" if previous else ""
        log(f"寫出 {path}（{len(records)} 筆）{delta}")

    log(f"更新了 {len(written)} 個表，{len(problems)} 個問題")

    # 抓完就推上 S3，讓 Athena 看到的資料跟本機檔案是同一批。分兩個步驟做的話，
    # 中間那段時間 Athena 查到的是上個月的數字，而畫面上不會有任何提示。
    if written and config.LAKE_SYNC_ON_REFRESH and config.S3_DATA_BUCKET:
        from app.data import lake

        log("推送到 S3 資料湖")
        try:
            # 只推這次真的重寫過的表。每小時的 YouBike 批次不該順手把 725 列的
            # population_youth 也重傳一次 —— 那張表來自指標快照，抓取不會改動它。
            # 指標表由 scripts/sync_lake.py（不帶 --only）在部署時整批推。
            summary = lake.sync(only=written, log=log)
            problems.extend(summary["skipped"])
        except Exception as error:  # noqa: BLE001
            # 上傳失敗不該讓整個更新算失敗：本機檔案已經寫好，網站照樣是新資料，
            # 只有 Athena 那條路會落後。
            logger.exception("lake sync failed")
            problems.append(f"S3 上傳失敗（本機資料已更新）：{error}")
            log(f"  失敗：{error}")
    elif written and config.LAKE_SYNC_ON_REFRESH:
        log("未設定 S3_DATA_BUCKET，跳過資料湖上傳")

    return {"written": written, "problems": problems, "counts": counts}
