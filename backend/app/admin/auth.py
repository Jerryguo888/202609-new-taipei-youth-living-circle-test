"""管理後台的帳號與登入工作階段。

這支檔案守的是整個專案風險最高的一道門：能登入後台的人可以上傳檔案進知識庫，
而知識庫的內容會餵給模型。也就是說「能上傳」等於「能對 AI 做提示注入」，
之後每個使用者問到相關問題都可能拿到被污染的答案。所以這裡的每個決定都偏保守。

實作選擇與理由：

密碼雜湊 用 PBKDF2-HMAC-SHA256，600,000 次疊代（OWASP 對 PBKDF2-SHA256 的建議值）。
    沒有選 bcrypt／argon2 是為了不引入 C extension 依賴；PBKDF2 在標準庫裡、
    行為明確、不會因為 wheel 缺失而在某個平台上裝不起來。

工作階段 是伺服器端的，cookie 裡只放隨機 token，而且**存的是 token 的 SHA-256**。
    這樣即使 users.json 被讀走，也沒辦法用裡面的值直接登入。

不做使用者列舉 帳號不存在和密碼錯誤回同一個訊息、走同一條時間路徑（不存在時也算一次
    假雜湊），避免用回應差異或時間差把帳號名稱掃出來。

鎖定 同一帳號連續失敗達上限就暫時鎖住，擋自動化猜密碼。

儲存 是 /data 上的 JSON 檔，用「暫存檔＋rename」原子寫入，並用一把行程內的鎖
    序列化寫入。單容器足夠；要跑多個複本就得換成真的資料庫（見 README）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app import config

logger = logging.getLogger("living-circle-chat.auth")

USERS_PATH = config.ADMIN_USERS_PATH

PBKDF2_ITERATIONS = config.ADMIN_PBKDF2_ITERATIONS
SALT_BYTES = 16
HASH_ALGORITHM = "pbkdf2_sha256"

SESSION_COOKIE = "lc_admin_session"
SESSION_TTL_MINUTES = config.ADMIN_SESSION_TTL_MINUTES
SESSION_COOKIE_SECURE = config.ADMIN_COOKIE_SECURE

MAX_FAILED_ATTEMPTS = config.ADMIN_MAX_FAILED_ATTEMPTS
LOCKOUT_MINUTES = config.ADMIN_LOCKOUT_MINUTES

MIN_PASSWORD_LENGTH = 12
ROLES = ("admin", "editor")

_lock = threading.Lock()
# token 的 sha256 -> session 資料。重啟就全部失效，這是可接受的：
# 後台使用頻率低，而且「重啟即登出」對安全性是加分。
_sessions: dict[str, dict] = {}


class AuthError(Exception):
    """給前端看的錯誤，訊息刻意不透露帳號是否存在。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------
# 密碼
# --------------------------------------------------------------------------
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "{}${}${}${}".format(
        HASH_ALGORITHM,
        PBKDF2_ITERATIONS,
        base64.b64encode(salt).decode(),
        base64.b64encode(derived).decode(),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_b64, hash_b64 = encoded.split("$")
        if algorithm != HASH_ALGORITHM:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
    except (ValueError, TypeError):
        return False
    # 一定要用 compare_digest：普通的 == 會提前 return，洩漏前綴相符的長度
    return hmac.compare_digest(derived, expected)


def _dummy_verify(password: str) -> None:
    """帳號不存在時也做一次同成本的雜湊。

    少了這一步，「帳號不存在」會比「密碼錯誤」快好幾百毫秒，
    等於送一個帳號列舉的旁通道給攻擊者。
    """
    hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), b"0" * SALT_BYTES, PBKDF2_ITERATIONS)


def validate_password(password: str) -> None:
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise AuthError(f"密碼至少需要 {MIN_PASSWORD_LENGTH} 個字元。")
    lowered = (password or "").lower()
    if lowered in ("password1234", "administrator", "123456789012", "qwertyuiop12"):
        raise AuthError("這個密碼太常見，請換一個。")
    # 不強制大小寫符號混用：長度對 PBKDF2 的實際保護遠大於字元類別規則，
    # 而過度嚴格的規則反而會讓人寫在便利貼上。


# --------------------------------------------------------------------------
# 使用者存放
# --------------------------------------------------------------------------
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _empty_store() -> dict:
    return {"schema_version": 1, "users": []}


def load_store() -> dict:
    if not USERS_PATH.exists():
        return _empty_store()
    try:
        data = json.loads(USERS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        # 這裡不要靜靜回空的 store：那會讓「檔案壞掉」看起來像「還沒建立帳號」，
        # 於是 bootstrap 腳本會允許再建一個管理員，等同繞過既有帳號。
        raise AuthError(f"無法讀取帳號檔 {USERS_PATH}：{error}", status=500)
    if not isinstance(data.get("users"), list):
        raise AuthError("帳號檔格式不正確。", status=500)
    return data


def save_store(store: dict) -> None:
    USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = USERS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, USERS_PATH)
    # 帳號檔只有擁有者可讀寫
    try:
        os.chmod(USERS_PATH, 0o600)
    except OSError:
        pass


def find_user(store: dict, username: str) -> dict | None:
    target = (username or "").strip().lower()
    for user in store["users"]:
        if user["username"].lower() == target:
            return user
    return None


def has_admin() -> bool:
    store = load_store()
    return any(u.get("role") == "admin" and not u.get("disabled") for u in store["users"])


def normalise_username(username: str) -> str:
    name = (username or "").strip()
    if not (3 <= len(name) <= 32):
        raise AuthError("帳號名稱長度需為 3 到 32 個字元。")
    if not all(c.isalnum() or c in "._-" for c in name):
        raise AuthError("帳號名稱只能使用英數字與 . _ - 這三個符號。")
    return name


def create_user(username: str, password: str, role: str = "editor", created_by: str = "system") -> dict:
    username = normalise_username(username)
    validate_password(password)
    if role not in ROLES:
        raise AuthError(f"role 只能是 {', '.join(ROLES)}。")

    with _lock:
        store = load_store()
        if find_user(store, username):
            raise AuthError("這個帳號名稱已經存在。", status=409)
        user = {
            "username": username,
            "password": hash_password(password),
            "role": role,
            "disabled": False,
            "created_at": _iso(_now()),
            "created_by": created_by,
            "last_login": None,
            "failed_attempts": 0,
            "locked_until": None,
        }
        store["users"].append(user)
        save_store(store)
    logger.info("created user %s (role=%s, by=%s)", username, role, created_by)
    return public_user(user)


def public_user(user: dict) -> dict:
    """對外只回不敏感的欄位，password 雜湊絕對不能出去。"""
    return {
        "username": user["username"],
        "role": user.get("role", "editor"),
        "disabled": bool(user.get("disabled")),
        "created_at": user.get("created_at"),
        "created_by": user.get("created_by"),
        "last_login": user.get("last_login"),
        "locked": _locked_until(user) is not None,
    }


def list_users() -> list[dict]:
    return [public_user(u) for u in load_store()["users"]]


def _locked_until(user: dict) -> datetime | None:
    raw = user.get("locked_until")
    if not raw:
        return None
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return moment if moment > _now() else None


def update_user(
    username: str,
    actor: str,
    role: str | None = None,
    disabled: bool | None = None,
    password: str | None = None,
    unlock: bool = False,
) -> dict:
    with _lock:
        store = load_store()
        user = find_user(store, username)
        if user is None:
            raise AuthError("找不到這個帳號。", status=404)

        is_self = user["username"].lower() == (actor or "").lower()

        if role is not None:
            if role not in ROLES:
                raise AuthError(f"role 只能是 {', '.join(ROLES)}。")
            # 不能把自己降級：否則一個人可以把系統弄成沒有管理員
            if is_self and role != "admin" and user.get("role") == "admin":
                raise AuthError("不能修改自己的角色，請由另一個管理員操作。", status=409)
            if user.get("role") == "admin" and role != "admin":
                _assert_other_admin_exists(store, user["username"])
            user["role"] = role

        if disabled is not None:
            if is_self and disabled:
                raise AuthError("不能停用自己的帳號。", status=409)
            if disabled and user.get("role") == "admin":
                _assert_other_admin_exists(store, user["username"])
            user["disabled"] = bool(disabled)
            if disabled:
                _revoke_sessions_for(user["username"])

        if password is not None:
            validate_password(password)
            user["password"] = hash_password(password)
            user["failed_attempts"] = 0
            user["locked_until"] = None
            # 改密碼一律踢掉該帳號所有工作階段。密碼被改的常見原因就是懷疑外洩，
            # 這時候讓舊 cookie 繼續有效等於沒改。
            _revoke_sessions_for(user["username"])

        if unlock:
            user["failed_attempts"] = 0
            user["locked_until"] = None

        save_store(store)
    logger.info("updated user %s by %s", username, actor)
    return public_user(user)


def delete_user(username: str, actor: str) -> None:
    with _lock:
        store = load_store()
        user = find_user(store, username)
        if user is None:
            raise AuthError("找不到這個帳號。", status=404)
        if user["username"].lower() == (actor or "").lower():
            raise AuthError("不能刪除自己的帳號。", status=409)
        if user.get("role") == "admin":
            _assert_other_admin_exists(store, user["username"])
        store["users"] = [u for u in store["users"] if u["username"] != user["username"]]
        _revoke_sessions_for(user["username"])
        save_store(store)
    logger.info("deleted user %s by %s", username, actor)


def _assert_other_admin_exists(store: dict, excluding: str) -> None:
    """避免把最後一個管理員刪掉／停用／降級。

    沒有這個檢查的話，後台會變成沒有人能進去，只能 SSH 進伺服器改 JSON 檔。
    """
    others = [
        u for u in store["users"]
        if u.get("role") == "admin" and not u.get("disabled") and u["username"] != excluding
    ]
    if not others:
        raise AuthError("系統必須保留至少一個可用的管理員帳號。", status=409)


# --------------------------------------------------------------------------
# 登入與工作階段
# --------------------------------------------------------------------------
def authenticate(username: str, password: str) -> dict:
    generic = "帳號或密碼錯誤。"

    with _lock:
        store = load_store()
        user = find_user(store, username)

        if user is None:
            _dummy_verify(password or "")
            raise AuthError(generic, status=401)

        locked = _locked_until(user)
        if locked:
            remaining = int((locked - _now()).total_seconds() // 60) + 1
            raise AuthError(f"嘗試次數過多，請於 {remaining} 分鐘後再試。", status=429)

        if user.get("disabled"):
            # 訊息與密碼錯誤相同，不告訴對方「這個帳號存在但被停用」
            _dummy_verify(password or "")
            raise AuthError(generic, status=401)

        if not verify_password(password or "", user["password"]):
            user["failed_attempts"] = int(user.get("failed_attempts") or 0) + 1
            if user["failed_attempts"] >= MAX_FAILED_ATTEMPTS:
                user["locked_until"] = _iso(_now() + timedelta(minutes=LOCKOUT_MINUTES))
                user["failed_attempts"] = 0
                logger.warning("locked account %s after repeated failures", user["username"])
            save_store(store)
            raise AuthError(generic, status=401)

        user["failed_attempts"] = 0
        user["locked_until"] = None
        user["last_login"] = _iso(_now())
        save_store(store)
        snapshot = public_user(user)

    logger.info("login ok for %s", snapshot["username"])
    return snapshot


@dataclass
class Session:
    token: str
    csrf: str
    username: str
    role: str
    expires_at: datetime


def create_session(user: dict) -> Session:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    expires = _now() + timedelta(minutes=SESSION_TTL_MINUTES)
    with _lock:
        _sessions[_token_key(token)] = {
            "username": user["username"],
            "role": user["role"],
            "csrf": csrf,
            "expires_at": expires,
        }
    return Session(token=token, csrf=csrf, username=user["username"], role=user["role"], expires_at=expires)


def _token_key(token: str) -> str:
    """只保存 token 的雜湊，記憶體 dump 或誤印 log 也拿不到可用的憑證。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def resolve_session(token: str | None) -> dict | None:
    if not token:
        return None
    key = _token_key(token)
    with _lock:
        entry = _sessions.get(key)
        if entry is None:
            return None
        if entry["expires_at"] <= _now():
            _sessions.pop(key, None)
            return None
        return dict(entry)


def revoke_session(token: str | None) -> None:
    if not token:
        return
    with _lock:
        _sessions.pop(_token_key(token), None)


def _revoke_sessions_for(username: str) -> None:
    """呼叫前必須已持有 _lock。"""
    target = username.lower()
    for key in [k for k, v in _sessions.items() if v["username"].lower() == target]:
        _sessions.pop(key, None)


def active_session_count() -> int:
    with _lock:
        return sum(1 for v in _sessions.values() if v["expires_at"] > _now())


def startup_warnings() -> list[str]:
    warnings = []
    if not SESSION_COOKIE_SECURE:
        warnings.append(
            "ADMIN_COOKIE_SECURE=false：工作階段 cookie 會在未加密的 HTTP 上傳輸。"
            "正式對外前請設定 HTTPS 並改為 true。"
        )
    try:
        if not has_admin():
            warnings.append(
                "尚未建立任何管理員帳號，請執行："
                "docker compose run --rm chat python scripts/create_admin.py"
            )
    except AuthError as error:
        warnings.append(str(error))
    return warnings
