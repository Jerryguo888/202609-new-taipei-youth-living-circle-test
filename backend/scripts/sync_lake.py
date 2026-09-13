#!/usr/bin/env python3
"""把目前的資料推上 S3 資料湖，供 Athena 查詢。

    python scripts/sync_lake.py                      # 全部
    python scripts/sync_lake.py --only youbike_stations
    python scripts/sync_lake.py --dry-run            # 只看會送什麼，不真的上傳

每月更新（scripts/fetch_sources.py）抓完會自動呼叫同一個 sync()，所以平常不必手動
跑這支。它的用途是：第一次建表前先把資料放上去、或是上傳失敗後單獨補一次。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.data import lake  # noqa: E402

ALL_TABLES = tuple(lake.RECORD_TABLE_COLUMNS) + lake.METRIC_TABLES


def main() -> int:
    parser = argparse.ArgumentParser(description="推送資料到 S3 資料湖（Athena 來源）")
    parser.add_argument(
        "--only",
        action="append",
        choices=list(ALL_TABLES),
        help="只推某一張表，可重複",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只印出會送哪些表與筆數，不呼叫 S3",
    )
    args = parser.parse_args()

    if args.dry_run:
        print("（dry-run，不會上傳）")
        print(f"目標 bucket：{config.S3_DATA_BUCKET or '（未設定）'}")
        print(f"前綴：{config.S3_CURATED_PREFIX}/")
        for table in args.only or ALL_TABLES:
            if table in lake.RECORD_TABLE_COLUMNS:
                rows = lake._read_records(table)
                columns = lake.RECORD_TABLE_COLUMNS[table]
            else:
                from app.data import metrics

                columns, builder = lake.METRIC_TABLE_BUILDERS[table]
                rows = builder(metrics.load_snapshot())
            sample = lake.to_jsonl(rows[:1], columns).decode("utf-8").strip()
            print(f"\n{table}：{len(rows)} 筆 -> {lake._key_for(table)}")
            print(f"  欄位 {', '.join(columns)}")
            if sample:
                print(f"  第一列 {sample[:200]}")
        return 0

    try:
        summary = lake.sync(only=args.only)
    except lake.LakeError as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 1

    if summary["skipped"]:
        print("\n注意：", file=sys.stderr)
        for item in summary["skipped"]:
            print(f"  - {item}", file=sys.stderr)

    if not summary["uploaded"]:
        print("沒有任何表被上傳。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
