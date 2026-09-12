#!/usr/bin/env python3
"""產生 curated/metrics_snapshot.json：AI 查數字時的單一事實來源。

為什麼要有這一層：

1. 聊天室和前端圖表必須引用同一份數字，否則 AI 講的和畫面上的會不一致。
2. Athena 每次查詢有 1~3 秒固定延遲、且每查一次最低以 10MB 計費。這些資料
   其實很小（29 個行政區、幾百到幾千列），把彙總結果預先算好放進記憶體，
   熱門問題就不必打 Athena。需要跨季比較或細粒度切片時才走 Athena。
3. 沒有 AWS 也能跑，本機開發和降級都靠這份快照。

正式環境的季度作業應該在 transform 完成後產出同樣格式的檔案上傳到 S3；
目前先從組員已經整理好的 CSV 產生，欄位對應是確定的。

用法（預設路徑已經指向專案內的位置，通常不必帶參數）：
    python scripts/build_snapshot.py
    python scripts/build_snapshot.py --data-dir ../frontend/public/data --strict
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from datetime import date, timezone, datetime
from pathlib import Path

# 讓「python scripts/build_snapshot.py」在沒設 PYTHONPATH 時也能 import app.*
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402

# 「新北市」是全市合計列，不是行政區，計算排名時必須排除，
# 否則它永遠是第一名。
CITY_TOTAL_AREA = "新北市"


def read_csv(path: Path) -> list[dict]:
    # 這些檔案有的帶 BOM（例如托嬰機構統計），utf-8-sig 可同時處理有無 BOM
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def to_int(value: str) -> int:
    text = (value or "").strip().replace(",", "")
    if not text:
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0


def build_youth_population(rows: list[dict]) -> tuple[dict, list[str]]:
    """年份 × 行政區的 20~29 / 30~34 人數。

    回傳 (資料, 對帳警告)。對帳方式：各行政區加總必須等於同年度的「新北市」
    合計列。對不上就回報，因為那代表來源缺列或多列，後續所有排名都會失真。
    """
    by_year: dict[str, dict[str, dict[str, int]]] = defaultdict(dict)
    city_totals: dict[str, dict[str, int]] = {}

    for row in rows:
        year = (row.get("year") or "").strip()
        area = (row.get("area") or "").strip()
        if not year or not area:
            continue
        entry = {
            "age20_29": to_int(row.get("age20~29")),
            "age30_34": to_int(row.get("age30~34")),
        }
        entry["age20_34"] = entry["age20_29"] + entry["age30_34"]
        if area == CITY_TOTAL_AREA:
            city_totals[year] = entry
        else:
            by_year[year][area] = entry

    warnings: list[str] = []
    for year, districts in by_year.items():
        if year not in city_totals:
            warnings.append(f"{year} 年缺少「{CITY_TOTAL_AREA}」合計列，無法對帳")
            continue
        for field in ("age20_29", "age30_34"):
            summed = sum(d[field] for d in districts.values())
            expected = city_totals[year][field]
            if summed != expected:
                diff = summed - expected
                warnings.append(
                    f"{year} 年 {field} 各區加總 {summed:,} != 合計 {expected:,}（差 {diff:+,}）"
                )

    return {"by_year": by_year, "city_totals": city_totals}, warnings


def build_childcare(rows: list[dict]) -> dict:
    """行政區的公共／私立托育機構數量。

    注意：這份是「機構數量」而不是「可收托人數」。容額要靠私立托嬰機構名冊的
    person 欄位，那份還沒進到這個快照，所以缺口只能用機構數推估，
    不要對外稱為容額。
    """
    facilities: dict[str, dict[str, int]] = {}
    for row in rows:
        area = (row.get("area") or "").strip()
        if not area or area == CITY_TOTAL_AREA:
            continue
        public = to_int(row.get("公共托育中心"))
        private = to_int(row.get("私立托嬰機構"))
        facilities[area] = {
            "public_centers": public,
            "private_centers": private,
            "total_centers": to_int(row.get("總計")) or (public + private),
        }
    return facilities


def build_snapshot(data_dir: Path) -> tuple[dict, list[str]]:
    youth_csv = data_dir / "3d_map" / "新北市20至34歲人數.csv"
    childcare_csv = data_dir / "raw" / "新北市托嬰機構數量統計.csv"
    districts_csv = data_dir / "3d_map" / "新北市行政區經緯度.csv"

    missing = [str(p) for p in (youth_csv, childcare_csv, districts_csv) if not p.exists()]
    if missing:
        raise SystemExit("找不到來源檔案：\n  " + "\n  ".join(missing))

    youth, warnings = build_youth_population(read_csv(youth_csv))
    childcare = build_childcare(read_csv(childcare_csv))

    districts = [
        (row.get("area") or "").strip()
        for row in read_csv(districts_csv)
        if (row.get("area") or "").strip() and (row.get("area") or "").strip() != CITY_TOTAL_AREA
    ]

    years = sorted(youth["by_year"].keys(), key=lambda y: int(y))
    latest_year = years[-1] if years else None

    # 托育缺口：每間機構要服務多少青年人口。數字越大代表越稀缺。
    # 用最新年度的 20~29 歲人口除以機構數。沒有機構的區記為 None 而不是 0 或無限，
    # 讓前端和模型都能看出「無機構」跟「機構很多」是不同狀況。
    gap_rows = {}
    if latest_year:
        for area, counts in childcare.items():
            youth_count = youth["by_year"].get(latest_year, {}).get(area, {}).get("age20_29")
            if youth_count is None:
                continue
            total = counts["total_centers"]
            gap_rows[area] = {
                "youth_20_29": youth_count,
                "total_centers": total,
                "youth_per_center": round(youth_count / total, 1) if total else None,
            }

    snapshot = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        # 正式環境由季度作業帶入 YYYY-QN；本機從 CSV 產生時標記 local
        "snapshot": "local",
        "source": "frontend/public/data (組員整理過的 curated CSV)",
        "districts": districts,
        "years": years,
        "latest_year": latest_year,
        "metrics": {
            "youth_population": {
                "label": "20~34 歲青年人口",
                "unit": "人",
                "dimensions": ["district", "year", "age_band"],
                "by_year": youth["by_year"],
                "city_totals": youth["city_totals"],
            },
            "childcare_facilities": {
                "label": "托育機構數量",
                "unit": "間",
                "dimensions": ["district", "facility_type"],
                "note": "這是機構數量，不是可收托人數",
                "by_district": childcare,
            },
            "childcare_pressure": {
                "label": "每間托育機構對應的 20~29 歲人口",
                "unit": "人/間",
                "dimensions": ["district"],
                "note": "以機構數推估的壓力指標，不等於容額缺口",
                "by_district": gap_rows,
            },
        },
    }
    return snapshot, warnings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-dir",
        default=str(config.PROJECT_ROOT.parent / "frontend" / "public" / "data"),
        help="來源 CSV 目錄（預設 %(default)s）",
    )
    parser.add_argument(
        "--out",
        default=str(config.BUNDLED_SNAPSHOT_PATH),
        help="輸出快照路徑（預設 %(default)s）",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="對帳有警告時以非零結束（季度作業請開啟，讓壞資料擋在關卡前）",
    )
    args = parser.parse_args()

    snapshot, warnings = build_snapshot(Path(args.data_dir))

    for warning in warnings:
        print(f"[對帳警告] {warning}", file=sys.stderr)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    metrics = snapshot["metrics"]
    print(f"寫出 {out_path}")
    print(f"  行政區 {len(snapshot['districts'])} 個")
    print(f"  年度 {snapshot['years'][0]}~{snapshot['latest_year']}（{len(snapshot['years'])} 年）")
    print(f"  托育機構統計 {len(metrics['childcare_facilities']['by_district'])} 區")
    print(f"  對帳警告 {len(warnings)} 筆")

    if warnings and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
