#!/usr/bin/env bash
# 確認後端「真的」在查 Athena，而不是安靜退回本機快照。
#
# 用法（在伺服器上）：
#   ./backend/athena/verify_athena.sh
#   ./backend/athena/verify_athena.sh http://127.0.0.1:8080
#
# 為什麼需要這支：METRIC_BACKEND=athena 只是叫後端「去試」。Athena 不通時
# app/data/metrics.py 會退回快照、HTTP 仍然回 200、數字看起來完全正常，
# 只是那是烘在 image 裡的舊資料。唯一可靠的判斷是回傳裡的 source 欄位。

set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
PASS=0
FAIL=0
WARN=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; WARN=$((WARN+1)); }
info() { printf '       %s\n' "$1"; }
head_() { printf '\n--- %s ---\n' "$1"; }

get() { curl --fail --silent --show-error --max-time 30 "$1" 2>/dev/null; }

# 用 python 取欄位，避免依賴 jq。欄位名走 argv 而不是字串內插，
# 免得欄位名裡有引號時把程式碼弄壞。
field() {
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit(0)
value = data
for key in sys.argv[1].split("."):
    value = value.get(key) if isinstance(value, dict) else None
print("" if value is None else value)
' "$1"
}

# ---------------------------------------------------------------------------
head_ "1. 設定（/api/health）"
# ---------------------------------------------------------------------------
health="$(get "$BASE/api/health")"
if [[ -z "$health" ]]; then
  bad "連不上 $BASE/api/health —— 服務沒起來或 port 不對"
  echo; echo "通過 $PASS，失敗 $FAIL，警告 $WARN"; exit 1
fi
backend="$(printf '%s' "$health" | field metricBackend)"
info "metricBackend = ${backend:-<空>}"
if [[ "$backend" == "athena" ]]; then
  ok "METRIC_BACKEND 已設為 athena"
else
  bad "METRIC_BACKEND 是「${backend}」，不是 athena。請設定後重啟 chat 容器。"
  info "這一步只反映環境變數，不代表 Athena 真的通。"
  echo; echo "通過 $PASS，失敗 $FAIL，警告 $WARN"; exit 1
fi

# ---------------------------------------------------------------------------
head_ "2. 指標查詢實際走哪一條（決定性的一步）"
# ---------------------------------------------------------------------------
m="$(get "$BASE/api/metrics/youth_population?limit=3&year=2024")"
if [[ -z "$m" ]]; then
  bad "/api/metrics 沒有回應"
else
  src="$(printf '%s' "$m" | field source)"
  info "source = ${src}"
  case "$src" in
    athena)
      ok "指標查詢真的走 Athena"
      scanned="$(printf '%s' "$m" | field scanned_bytes)"
      if [[ -n "$scanned" && "$scanned" != "0" ]]; then
        ok "有掃描量回報：scanned_bytes = ${scanned}（約 $((scanned/1024)) KB）"
        info "Athena 最低以 10 MB 計費，所以每次查詢都是 10 MB 的錢。"
      else
        warn "沒有 scanned_bytes，無法確認掃了多少資料"
      fi
      ;;
    local-snapshot)
      bad "退回了本機快照 —— Athena 沒有被使用"
      notes="$(printf '%s' "$m" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for n in d.get('notes') or []:
    print('       ', n)
" 2>/dev/null)"
      if [[ -n "$notes" ]]; then
        info "後端給的原因："
        printf '%s\n' "$notes"
      else
        info "回傳裡沒有 notes，去看容器日誌找原因（見最後一節）"
      fi
      ;;
    *) bad "source 是未知值「${src}」" ;;
  esac
fi

# ---------------------------------------------------------------------------
head_ "3. 名冊查詢（走另一條 store，要分開確認）"
# ---------------------------------------------------------------------------
r="$(get "$BASE/api/records/vaccine_schedules?limit=2")"
if [[ -z "$r" ]]; then
  bad "/api/records 沒有回應"
else
  rsrc="$(printf '%s' "$r" | field source)"
  info "source = ${rsrc}"
  case "$rsrc" in
    athena)        ok "名冊查詢也走 Athena" ;;
    local-records) bad "名冊退回了本機檔案（指標與名冊是兩個獨立的 store）" ;;
    *)             bad "source 是未知值「${rsrc}」" ;;
  esac
fi

# ---------------------------------------------------------------------------
head_ "4. 正確性：Athena 的答案要跟快照一致"
# ---------------------------------------------------------------------------
# 兩邊資料應該同源，數字不同就代表上傳的 JSONL 或 DDL 有問題
# （欄位名對不上時 Athena 會回 NULL 而不報錯）。
if [[ "$(printf '%s' "$m" | field source)" == "athena" ]]; then
  rows="$(printf '%s' "$m" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for row in d.get('rows') or []:
    print(row.get('district'), row.get('value'))
" 2>/dev/null)"
  info "Athena 回的 2024 年前三名："
  printf '%s\n' "$rows" | sed 's/^/         /'
  expected="板橋區 58423
新莊區 49181
中和區 43593"
  if [[ "$rows" == "$expected" ]]; then
    ok "數字與指標快照完全一致"
  else
    bad "數字與快照不一致 —— 上傳的資料或 DDL 有問題"
    info "期望："
    printf '%s\n' "$expected" | sed 's/^/         /'
    info "全是 None/空值的話，通常是 JSONL 欄位名與 DDL 對不上。"
  fi
else
  warn "跳過（前一步不是 athena）"
fi

# ---------------------------------------------------------------------------
head_ "5. AI 工具走的是同一條路徑"
# ---------------------------------------------------------------------------
meta="$(get "$BASE/api/meta/datasets")"
if [[ -n "$meta" ]]; then
  snap="$(printf '%s' "$meta" | field snapshot)"
  info "list_available_data 回報的 snapshot = ${snap:-<無>}"
  ok "/api/meta/datasets 可用（AI 的 list_available_data 走同一個 dispatch）"
else
  warn "/api/meta/datasets 沒有回應"
fi

# ---------------------------------------------------------------------------
head_ "6. 容器日誌裡的 Athena 失敗紀錄"
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  logs="$(docker compose logs --tail 400 chat 2>/dev/null | grep -i "athena" | tail -6)"
  if [[ -n "$logs" ]]; then
    warn "日誌裡有 Athena 相關訊息："
    printf '%s\n' "$logs" | sed 's/^/         /'
    info "「Athena unavailable」後面那段就是真正的原因。"
  else
    ok "日誌裡沒有 Athena 失敗紀錄"
  fi
else
  info "找不到 docker 指令，跳過日誌檢查"
fi

# ---------------------------------------------------------------------------
echo
echo "通過 $PASS，失敗 $FAIL，警告 $WARN"
if (( FAIL > 0 )); then
  cat <<'HINT'

常見原因對照（看日誌裡的錯誤字樣）：
  no output location / ResultConfiguration
      -> ATHENA_OUTPUT_LOCATION 沒設，或不是 s3:// 開頭、結尾少了 /
  AccessDenied / not authorized
      -> EC2 instance role 少權限。最常漏的是 glue:GetTable ——
         Athena 透過 Glue Data Catalog 讀 schema，少了會出現看起來
         跟權限無關的錯誤。你自己在 console 查得到不代表 role 也行。
  Table ... does not exist / Database ... not found
      -> 表沒建，或 ATHENA_DATABASE 與實際建的資料庫名不一致
  COUNT 查得到但這裡回 NULL
      -> JSONL 欄位名與 DDL 對不上，或檔案被寫成 JSON 陣列而非一行一物件
HINT
  exit 1
fi
echo "Athena 已生效。"
