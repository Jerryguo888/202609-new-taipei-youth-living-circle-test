#!/usr/bin/env python3
"""抓取開放資料 API 並寫出逐筆記錄（每月排程用）。

    python scripts/fetch_sources.py --out /data/records
    python scripts/fetch_sources.py --only childcare_centers --strict

實際邏輯在 app/data/fetch.py，這裡只做參數解析與結束碼。後台的「立即更新」
按鈕呼叫同一個 fetch_all()，所以兩條路徑的行為不會分岔。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 讓「python scripts/fetch_sources.py」在沒設 PYTHONPATH 時也能 import app.*
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.data import fetch  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="抓取並正規化開放資料 API")
    parser.add_argument(
        "--out",
        default=str(config.RECORDS_DIR),
        help=f"輸出目錄（預設 {config.RECORDS_DIR}）",
    )
    parser.add_argument("--only", action="append", help="只抓某個輸出表名，可重複")
    parser.add_argument(
        "--max-shrink",
        type=float,
        default=config.FETCH_MAX_SHRINK,
        help="允許的筆數下降比例，超過就不覆蓋既有檔案（預設 %(default)s）",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="有任何來源失敗或被關卡擋下時以非零結束（排程作業請開啟）",
    )
    args = parser.parse_args()

    try:
        summary = fetch.fetch_all(
            out_dir=Path(args.out),
            only=args.only,
            max_shrink=args.max_shrink,
        )
    except fetch.FetchError as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 1

    if summary["problems"]:
        print("\n注意：", file=sys.stderr)
        for problem in summary["problems"]:
            print(f"  - {problem}", file=sys.stderr)

    if not summary["written"]:
        print("沒有任何表被更新。", file=sys.stderr)
        return 1
    if summary["problems"] and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
