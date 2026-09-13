#!/usr/bin/env bash
# 依序把 schema.sql 的每一個敘述送進 Athena。
#
# 為什麼需要這支：Athena 的 Query editor 一次只接受一個敘述，整份 schema.sql
# 貼進去會得到 "Only one sql statement is allowed"。這裡用 CLI 逐一送出，
# 並等每一個做完才送下一個 —— CREATE TABLE 必須在 CREATE DATABASE 之後，
# 平行送會有一半失敗。
#
# 用法：
#   ./backend/athena/apply_athena_schema.sh 20260912-bucket
#   ./backend/athena/apply_athena_schema.sh 20260912-bucket us-east-1
#   SKIP_DROP=1 ./backend/athena/apply_athena_schema.sh 20260912-bucket   # 第一次建立
#
# 需要本機已設好可用的 AWS 憑證（aws configure 或 SSO）。
# 注意：你自己的 IAM 身分查得到，不代表 EC2 的 instance role 也查得到 ——
# 那是兩組權限，後端要用的是後者。

set -euo pipefail

BUCKET="${1:-}"
REGION="${2:-${AWS_REGION:-us-west-2}}"
DATABASE="${ATHENA_DATABASE:-ntpc_youth}"
WORKGROUP="${ATHENA_WORKGROUP:-primary}"
OUTPUT="${ATHENA_OUTPUT_LOCATION:-s3://${BUCKET}/athena-results/}"
SCHEMA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/schema.sql"

if [[ -z "$BUCKET" ]]; then
  echo "用法：$0 <資料湖 bucket 名稱> [region]" >&2
  exit 2
fi
if [[ ! -f "$SCHEMA" ]]; then
  echo "找不到 $SCHEMA" >&2
  exit 1
fi

echo "bucket    $BUCKET"
echo "region    $REGION"
echo "database  $DATABASE"
echo "workgroup $WORKGROUP"
echo "output    $OUTPUT"
echo

# 把 DDL 讀進來：換掉 bucket、去掉註解與空行，再依分號切成一個個敘述。
sql_body="$(sed "s|__BUCKET__|${BUCKET}|g" "$SCHEMA" | sed 's/--.*$//' | tr '\n' ' ')"

failed=0
total=0

# 用 ; 當分隔逐一送出。schema.sql 的字串常值裡沒有分號，所以這樣切是安全的。
while IFS= read -r statement; do
  statement="$(echo "$statement" | tr -s ' ' | sed 's/^ *//;s/ *$//')"
  [[ -z "$statement" ]] && continue

  if [[ -n "${SKIP_DROP:-}" && "$statement" == DROP* ]]; then
    echo "跳過（SKIP_DROP）：${statement:0:60}"
    continue
  fi

  total=$((total + 1))
  label="${statement:0:70}"
  printf '[%02d] %s...\n' "$total" "$label"

  # CREATE DATABASE 不能帶 QueryExecutionContext 的 Database（那個庫還不存在）
  context=()
  if [[ "$statement" != CREATE\ DATABASE* ]]; then
    context=(--query-execution-context "Database=${DATABASE}")
  fi

  qid="$(aws athena start-query-execution \
    --region "$REGION" \
    --work-group "$WORKGROUP" \
    --query-string "$statement" \
    --result-configuration "OutputLocation=${OUTPUT}" \
    "${context[@]}" \
    --query QueryExecutionId --output text)"

  # 等它跑完再送下一個：DDL 之間有先後依賴
  while true; do
    read -r state reason <<<"$(aws athena get-query-execution \
      --region "$REGION" --query-execution-id "$qid" \
      --query 'QueryExecution.Status.[State,StateChangeReason]' --output text)"
    case "$state" in
      SUCCEEDED) echo "     成功"; break ;;
      FAILED|CANCELLED)
        echo "     失敗：$reason" >&2
        failed=$((failed + 1))
        break ;;
      *) sleep 1 ;;
    esac
  done
done < <(echo "$sql_body" | tr ';' '\n')

echo
if (( failed > 0 )); then
  echo "共 $total 個敘述，$failed 個失敗。" >&2
  exit 1
fi
echo "共 $total 個敘述，全部成功。"
echo
echo "接著自己驗一次筆數（應為 725）："
echo "  aws athena start-query-execution --region $REGION --work-group $WORKGROUP \\"
echo "    --query-execution-context Database=$DATABASE \\"
echo "    --result-configuration OutputLocation=$OUTPUT \\"
echo "    --query-string 'SELECT COUNT(*) FROM ${DATABASE}.population_youth'"
