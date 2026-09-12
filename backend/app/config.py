"""集中管理環境變數與路徑。

兩個問題在這裡一次解決：

**空字串不是「沒設定」** compose 的 `${VAR:-}` 在變數未設定時會傳入空字串，而
`os.getenv(name, default)` 只有在「完全沒有這個變數」時才會用 default。少了
`env_str` 這一層，`SYSTEM_PROMPT=` 會變成真的空提示詞而不是回到預設值。

**路徑不要依賴工作目錄** 原本 `curated/metrics_snapshot.json` 這種相對路徑只有在
CWD 剛好是 backend/ 時才找得到，換個地方執行腳本就壞掉。這裡一律從
`PROJECT_ROOT` 推導，並保留環境變數覆寫。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger("living-circle-chat.config")

# app/config.py -> app/ -> 專案根目錄（容器裡是 /srv）
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def env_str(name: str, default: str) -> str:
    return (os.getenv(name) or "").strip() or default


def env_int(name: str, default: int) -> int:
    try:
        return int(env_str(name, str(default)))
    except ValueError:
        logger.warning("%s 不是整數，改用預設值 %s", name, default)
        return default


def env_bool(name: str, default: bool) -> bool:
    raw = env_str(name, "true" if default else "false").lower()
    return raw not in ("false", "0", "no", "off")


def env_path(name: str, default: Path) -> Path:
    raw = (os.getenv(name) or "").strip()
    return Path(raw) if raw else default


# --------------------------------------------------------------------------
# AWS 與模型
# --------------------------------------------------------------------------
AWS_REGION = env_str("AWS_REGION", "us-west-2")
MODEL_ID = env_str("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
MAX_TOKENS = env_int("MAX_TOKENS", 2048)

# 空字串代表不接知識庫，只用模型本身回答
KNOWLEDGE_BASE_ID = (os.getenv("KNOWLEDGE_BASE_ID") or "").strip()
KB_NUM_RESULTS = env_int("KB_NUM_RESULTS", 5)
# managed 對應 S3 Vectors 這類受管知識庫，vector 對應自建向量庫
KB_SEARCH_MODE = env_str("KB_SEARCH_MODE", "managed").lower()

# --------------------------------------------------------------------------
# 對話行為
# --------------------------------------------------------------------------
ENABLE_CHARTS = env_bool("ENABLE_CHARTS", True)
ENABLE_TOOLS = env_bool("ENABLE_TOOLS", True)
MAX_TOOL_ROUNDS = env_int("MAX_TOOL_ROUNDS", 4)

# /api/chat 沒有身分驗證，這兩個上限是擋濫用的最後一道
MAX_HISTORY_MESSAGES = env_int("MAX_HISTORY_MESSAGES", 20)
MAX_MESSAGE_CHARS = env_int("MAX_MESSAGE_CHARS", 4000)

# --------------------------------------------------------------------------
# 資料位置
# --------------------------------------------------------------------------
# image 內建的資料（隨程式打包，第一次更新前的墊底）
BUNDLED_CURATED_DIR = env_path("BUNDLED_CURATED_DIR", PROJECT_ROOT / "curated")
BUNDLED_SNAPSHOT_PATH = BUNDLED_CURATED_DIR / "metrics_snapshot.json"
BUNDLED_RECORDS_DIR = env_path("BUNDLED_RECORDS_DIR", BUNDLED_CURATED_DIR / "records")

# 掛載進來的可寫資料（每月更新寫這裡，優先於內建版本）
DATA_DIR = env_path("DATA_DIR", Path("/data"))
LIVE_SNAPSHOT_PATH = env_path("LIVE_SNAPSHOT_PATH", DATA_DIR / "metrics_snapshot.json")
RECORDS_DIR = env_path("RECORDS_DIR", DATA_DIR / "records")

DATA_SOURCES_PATH = env_path("DATA_SOURCES_PATH", PROJECT_ROOT / "data_sources.yaml")

FETCH_MAX_SHRINK = float(env_str("FETCH_MAX_SHRINK", "0.5"))

# --------------------------------------------------------------------------
# 指標後端
# --------------------------------------------------------------------------
METRIC_BACKEND = env_str("METRIC_BACKEND", "local").lower()
ATHENA_DATABASE = env_str("ATHENA_DATABASE", "ntpc_youth")
ATHENA_WORKGROUP = env_str("ATHENA_WORKGROUP", "primary")
ATHENA_OUTPUT = env_str("ATHENA_OUTPUT_LOCATION", "")
ATHENA_TIMEOUT_SECONDS = env_int("ATHENA_TIMEOUT_SECONDS", 20)

# --------------------------------------------------------------------------
# 後台
# --------------------------------------------------------------------------
ADMIN_USERS_PATH = env_path("ADMIN_USERS_PATH", DATA_DIR / "admin" / "users.json")
ADMIN_PBKDF2_ITERATIONS = env_int("ADMIN_PBKDF2_ITERATIONS", 600000)
ADMIN_SESSION_TTL_MINUTES = env_int("ADMIN_SESSION_TTL_MINUTES", 480)
# 明文 HTTP 下設 Secure 會讓 cookie 完全送不出去，所以預設關閉但啟動時會警告
ADMIN_COOKIE_SECURE = env_bool("ADMIN_COOKIE_SECURE", False)
ADMIN_MAX_FAILED_ATTEMPTS = env_int("ADMIN_MAX_FAILED_ATTEMPTS", 5)
ADMIN_LOCKOUT_MINUTES = env_int("ADMIN_LOCKOUT_MINUTES", 15)

KB_BUCKET = env_str("KB_BUCKET", "")
KB_PREFIX = env_str("KB_PREFIX", "kb/docs/").lstrip("/")
KB_DATA_SOURCE_ID = env_str("KB_DATA_SOURCE_ID", "")
KB_MAX_UPLOAD_BYTES = env_int("KB_MAX_UPLOAD_MB", 20) * 1024 * 1024


def boto_config(read_timeout: int = 60):
    """所有 AWS client 共用的設定。

    region 一定要明確帶：boto3 只認 AWS_DEFAULT_REGION，不一定會吃 compose 傳進來的
    AWS_REGION。漏掉會得到 "You must specify a region."，而那個錯誤看起來很像
    「服務不可用」，實際上是設定漏了一個參數。
    """
    from botocore.config import Config

    return Config(
        region_name=AWS_REGION,
        connect_timeout=5,
        read_timeout=read_timeout,
        retries={"max_attempts": 2, "mode": "standard"},
    )
