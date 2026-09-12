"""後台 API：登入、帳號管理、知識庫檔案、手動更新資料。

安全性的三個原則：

1. 除了 /api/admin/login 和 /api/admin/session，所有路由都必須通過 require_user。
   不是靠「前端不顯示按鈕」來保護，前端只是介面。
2. 會改變狀態的請求（POST/PUT/DELETE）都要帶正確的 CSRF token。
   cookie 是 SameSite=Strict 已經擋掉大部分情境，這是第二道。
3. 帳號管理只有 admin 能碰；editor 只能上傳知識庫檔案與觸發資料更新。

上傳走後端而不是 presigned URL：檔案不大，走後端可以在碰到 S3 之前先驗副檔名與
大小，也不用去設 bucket 的 CORS。
"""

from __future__ import annotations

import logging
import os
import re
import threading
from datetime import datetime, timezone

from fastapi import APIRouter, Cookie, Depends, File, Header, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import config
from app.admin import auth
from app.data.records import freshness

logger = logging.getLogger("living-circle-chat.admin")

router = APIRouter(prefix="/api/admin")

AWS_REGION = config.AWS_REGION
KB_BUCKET = config.KB_BUCKET
KB_PREFIX = config.KB_PREFIX
KNOWLEDGE_BASE_ID = config.KNOWLEDGE_BASE_ID
KB_DATA_SOURCE_ID = config.KB_DATA_SOURCE_ID

MAX_UPLOAD_BYTES = config.KB_MAX_UPLOAD_BYTES
# 只放行知識庫真的用得到的文件型別。不要放行 html/svg：那些會被當成有腳本的內容，
# 而且知識庫的內容最終會進到模型的上下文。
ALLOWED_EXTENSIONS = {".pdf", ".csv", ".txt", ".md", ".docx", ".xlsx", ".json"}
SAFE_NAME = re.compile(r"^[\w\u4e00-\u9fff .()\-]{1,120}$")

# 資料更新是長工作，同時跑兩次會互相覆寫檔案
_refresh_lock = threading.Lock()
_refresh_state: dict = {"running": False, "started_at": None, "finished_at": None, "result": None}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# 相依：驗證與授權
# --------------------------------------------------------------------------
def require_user(
    request: Request,
    lc_admin_session: str | None = Cookie(default=None, alias=auth.SESSION_COOKIE),
    x_csrf_token: str | None = Header(default=None),
) -> dict:
    session = auth.resolve_session(lc_admin_session)
    if session is None:
        raise _http(401, "請先登入。")

    # 只有會改狀態的方法需要 CSRF；GET 不需要，否則單純讀取也會很難用
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        if not x_csrf_token or not _constant_equals(x_csrf_token, session["csrf"]):
            raise _http(403, "CSRF token 不正確，請重新載入頁面。")
    return session


def require_admin(session: dict = Depends(require_user)) -> dict:
    if session.get("role") != "admin":
        raise _http(403, "這個操作需要管理員權限。")
    return session


def _constant_equals(left: str, right: str) -> bool:
    import hmac

    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


class _HttpError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message


def _http(status: int, message: str) -> _HttpError:
    return _HttpError(status, message)


def install_error_handlers(app) -> None:
    @app.exception_handler(_HttpError)
    async def _handle_http_error(_request, exc: _HttpError):
        return JSONResponse(status_code=exc.status, content={"error": exc.message})

    @app.exception_handler(auth.AuthError)
    async def _handle_auth_error(_request, exc: auth.AuthError):
        return JSONResponse(status_code=exc.status, content={"error": exc.message})


# --------------------------------------------------------------------------
# 登入
# --------------------------------------------------------------------------
class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginBody, response: Response):
    user = auth.authenticate(body.username, body.password)
    store_user = {"username": user["username"], "role": user["role"]}
    session = auth.create_session(store_user)
    response.set_cookie(
        auth.SESSION_COOKIE,
        session.token,
        max_age=auth.SESSION_TTL_MINUTES * 60,
        httponly=True,          # JS 讀不到，降低 XSS 竊取 cookie 的影響
        samesite="strict",      # 跨站請求不帶 cookie，這是主要的 CSRF 防線
        secure=auth.SESSION_COOKIE_SECURE,
        path="/",
    )
    return {"user": user, "csrf": session.csrf, "expires_at": session.expires_at.isoformat()}


@router.post("/logout")
def logout(
    response: Response,
    lc_admin_session: str | None = Cookie(default=None, alias=auth.SESSION_COOKIE),
):
    auth.revoke_session(lc_admin_session)
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/session")
def session_info(
    lc_admin_session: str | None = Cookie(default=None, alias=auth.SESSION_COOKIE),
):
    """前端載入時用來判斷要顯示登入畫面還是後台。未登入回 200 而不是 401，
    因為「還沒登入」是正常狀態，不該在 console 留一排紅色錯誤。"""
    session = auth.resolve_session(lc_admin_session)
    if session is None:
        return {"authenticated": False}
    return {
        "authenticated": True,
        "user": {"username": session["username"], "role": session["role"]},
        "csrf": session["csrf"],
    }


# --------------------------------------------------------------------------
# 帳號管理（僅 admin）
# --------------------------------------------------------------------------
class CreateUserBody(BaseModel):
    username: str
    password: str
    role: str = "editor"


class UpdateUserBody(BaseModel):
    role: str | None = None
    disabled: bool | None = None
    password: str | None = None
    unlock: bool = False


@router.get("/users")
def get_users(_session: dict = Depends(require_admin)):
    return {"users": auth.list_users(), "roles": list(auth.ROLES)}


@router.post("/users")
def post_user(body: CreateUserBody, session: dict = Depends(require_admin)):
    user = auth.create_user(body.username, body.password, role=body.role, created_by=session["username"])
    return {"user": user}


@router.put("/users/{username}")
def put_user(username: str, body: UpdateUserBody, session: dict = Depends(require_admin)):
    user = auth.update_user(
        username,
        actor=session["username"],
        role=body.role,
        disabled=body.disabled,
        password=body.password,
        unlock=body.unlock,
    )
    return {"user": user}


@router.delete("/users/{username}")
def remove_user(username: str, session: dict = Depends(require_admin)):
    auth.delete_user(username, actor=session["username"])
    return {"ok": True}


# --------------------------------------------------------------------------
# 知識庫檔案
# --------------------------------------------------------------------------
def _s3():
    import boto3  # 延後 import：沒有用到後台的部署不必付這個成本

    return boto3.client("s3", config=config.boto_config(read_timeout=60))


def _bedrock_agent():
    import boto3

    return boto3.client("bedrock-agent", config=config.boto_config(read_timeout=30))


def _require_kb_config() -> None:
    missing = []
    if not KB_BUCKET:
        missing.append("KB_BUCKET")
    if not KNOWLEDGE_BASE_ID:
        missing.append("KNOWLEDGE_BASE_ID")
    if missing:
        raise _http(503, "知識庫尚未設定：缺少 " + "、".join(missing) + "。請在部署設定中補上。")


def _resolve_data_source_id() -> str:
    """沒設定 KB_DATA_SOURCE_ID 就自動找。

    知識庫通常只掛一個 S3 資料來源，要人工去 console 抄 ID 很容易抄錯，
    所以預設自動查；有多個時才要求明確指定。
    """
    global KB_DATA_SOURCE_ID
    if KB_DATA_SOURCE_ID:
        return KB_DATA_SOURCE_ID
    listed = _bedrock_agent().list_data_sources(knowledgeBaseId=KNOWLEDGE_BASE_ID)
    summaries = listed.get("dataSourceSummaries") or []
    if not summaries:
        raise _http(503, "這個知識庫沒有任何資料來源。")
    if len(summaries) > 1:
        ids = ", ".join(s["dataSourceId"] for s in summaries)
        raise _http(409, f"知識庫有多個資料來源（{ids}），請設定 KB_DATA_SOURCE_ID 指定要同步哪一個。")
    KB_DATA_SOURCE_ID = summaries[0]["dataSourceId"]
    return KB_DATA_SOURCE_ID


def _safe_key(filename: str) -> str:
    raw = (filename or "").strip()
    if not raw:
        raise _http(400, "檔名不可為空。")

    # 先檢查原始輸入再取 basename。順序反過來的話，basename 會把 "a/b.pdf" 變成
    # "b.pdf" 然後通過檢查 —— 雖然不會造成路徑穿越，但等於默默改掉使用者的檔名，
    # 而且讓「檔名不可包含路徑」這個檢查形同虛設。
    if ".." in raw or "/" in raw or "\\" in raw:
        raise _http(400, "檔名不可包含路徑，請只提供檔名本身。")

    # 再取一次 basename 當第二道防線（例如某些 client 會送 Windows 路徑）
    name = os.path.basename(raw)
    if not name:
        raise _http(400, "檔名不可為空。")
    if not SAFE_NAME.match(name):
        raise _http(400, "檔名含有不允許的字元，請只使用中英文、數字、空格與 . - _ ( )。")
    extension = os.path.splitext(name)[1].lower()
    if extension not in ALLOWED_EXTENSIONS:
        allowed = "、".join(sorted(ALLOWED_EXTENSIONS))
        raise _http(400, f"不支援的檔案型別 {extension or '（無）'}。可用：{allowed}")
    return KB_PREFIX + name


@router.get("/kb/files")
def list_kb_files(_session: dict = Depends(require_user)):
    _require_kb_config()
    try:
        paginator = _s3().get_paginator("list_objects_v2")
        files = []
        for page in paginator.paginate(Bucket=KB_BUCKET, Prefix=KB_PREFIX):
            for item in page.get("Contents") or []:
                if item["Key"].endswith("/"):
                    continue
                files.append({
                    "key": item["Key"],
                    "name": item["Key"][len(KB_PREFIX):] or item["Key"],
                    "size": item["Size"],
                    "modified": item["LastModified"].isoformat(),
                })
        files.sort(key=lambda f: f["modified"], reverse=True)
        return {"bucket": KB_BUCKET, "prefix": KB_PREFIX, "files": files}
    except Exception as error:  # noqa: BLE001
        logger.error("list kb files failed: %s", error)
        raise _http(502, f"無法讀取 S3：{error}")


@router.post("/kb/files")
async def upload_kb_file(
    _session: dict = Depends(require_user),
    file: UploadFile = File(...),
):
    _require_kb_config()
    key = _safe_key(file.filename)

    # 邊讀邊累加長度並在超過上限時中止。不要先 read() 全部再檢查大小，
    # 那等於讓任何登入者都能用一個大檔把容器的記憶體吃光。
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise _http(413, f"檔案超過上限 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB。")
        chunks.append(chunk)
    if total == 0:
        raise _http(400, "檔案是空的。")

    try:
        _s3().put_object(
            Bucket=KB_BUCKET,
            Key=key,
            Body=b"".join(chunks),
            ServerSideEncryption="AES256",
        )
    except Exception as error:  # noqa: BLE001
        logger.error("upload failed: %s", error)
        raise _http(502, f"上傳到 S3 失敗：{error}")

    logger.info("uploaded %s (%s bytes) by %s", key, total, _session["username"])
    return {
        "key": key,
        "size": total,
        "note": "檔案已上傳，但還沒進入知識庫。請執行「同步知識庫」讓它可被檢索。",
    }


@router.delete("/kb/files")
def delete_kb_file(key: str, session: dict = Depends(require_admin)):
    """刪除限管理員。誤刪知識庫文件會直接改變 AI 的回答內容。"""
    _require_kb_config()
    if not key.startswith(KB_PREFIX):
        raise _http(400, "只能刪除知識庫前綴底下的檔案。")
    try:
        _s3().delete_object(Bucket=KB_BUCKET, Key=key)
    except Exception as error:  # noqa: BLE001
        raise _http(502, f"刪除失敗：{error}")
    logger.info("deleted %s by %s", key, session["username"])
    return {"ok": True, "note": "已從 S3 刪除，請再執行一次同步讓知識庫移除該內容。"}


@router.post("/kb/sync")
def start_sync(_session: dict = Depends(require_user)):
    _require_kb_config()
    data_source_id = _resolve_data_source_id()
    try:
        job = _bedrock_agent().start_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=data_source_id,
            description=f"admin console sync by {_session['username']}",
        )["ingestionJob"]
    except Exception as error:  # noqa: BLE001
        logger.error("start ingestion failed: %s", error)
        raise _http(502, f"啟動同步失敗：{error}")
    return {"jobId": job["ingestionJobId"], "status": job["status"], "dataSourceId": data_source_id}


@router.get("/kb/sync/{job_id}")
def sync_status(job_id: str, _session: dict = Depends(require_user)):
    _require_kb_config()
    data_source_id = _resolve_data_source_id()
    try:
        job = _bedrock_agent().get_ingestion_job(
            knowledgeBaseId=KNOWLEDGE_BASE_ID,
            dataSourceId=data_source_id,
            ingestionJobId=job_id,
        )["ingestionJob"]
    except Exception as error:  # noqa: BLE001
        raise _http(502, f"查詢同步狀態失敗：{error}")
    return {
        "jobId": job["ingestionJobId"],
        "status": job["status"],
        "statistics": job.get("statistics", {}),
        "failureReasons": job.get("failureReasons", []),
        "updatedAt": job.get("updatedAt").isoformat() if job.get("updatedAt") else None,
    }


# --------------------------------------------------------------------------
# 手動更新開放資料
# --------------------------------------------------------------------------
def _run_refresh() -> None:
    """在背景執行緒裡跑資料抓取。

    刻意不用 docker socket 去 `docker compose run refresh`：把 socket 掛進一個
    對外服務等於給它 host 的 root 權限。直接在行程內跑同一份程式碼即可。
    """
    from app.data import fetch, metrics, records

    lines: list[str] = []
    ok = False
    try:
        summary = fetch.fetch_all(
            out_dir=records.RECORDS_DIR,
            max_shrink=config.FETCH_MAX_SHRINK,
            log=lines.append,
        )
        # 有問題但仍寫出了表，算部分成功；完全沒寫出東西才算失敗。
        ok = bool(summary["written"]) and not summary["problems"]
        for problem in summary["problems"]:
            lines.append(f"問題：{problem}")
    except Exception as error:  # noqa: BLE001
        logger.exception("manual refresh failed")
        lines.append(f"例外：{error}")
    finally:
        # 清掉快取，讓下一次查詢立刻讀到新檔案（mtime 也會變，這是雙重保險）
        records.LocalRecordStore._cache.clear()
        metrics._snapshot_cache = None
        with _refresh_lock:
            _refresh_state.update(
                running=False,
                finished_at=_now_iso(),
                result={"ok": ok, "log": "\n".join(lines)[-4000:]},
            )


@router.post("/refresh")
def trigger_refresh(_session: dict = Depends(require_user)):
    with _refresh_lock:
        if _refresh_state["running"]:
            raise _http(409, "已經有一個更新在進行中。")
        _refresh_state.update(running=True, started_at=_now_iso(), finished_at=None, result=None)
    threading.Thread(target=_run_refresh, name="manual-refresh", daemon=True).start()
    logger.info("manual refresh started by %s", _session["username"])
    return {"started": True}


@router.get("/refresh/status")
def refresh_status(_session: dict = Depends(require_user)):
    with _refresh_lock:
        state = dict(_refresh_state)
    state["tables"] = freshness()
    return state


# --------------------------------------------------------------------------
# 系統狀態
# --------------------------------------------------------------------------
@router.get("/status")
def system_status(_session: dict = Depends(require_user)):
    return {
        "region": AWS_REGION,
        "knowledgeBaseId": KNOWLEDGE_BASE_ID or None,
        "kbBucket": KB_BUCKET or None,
        "kbPrefix": KB_PREFIX,
        "metricBackend": config.METRIC_BACKEND,
        "maxUploadMb": MAX_UPLOAD_BYTES // (1024 * 1024),
        "allowedExtensions": sorted(ALLOWED_EXTENSIONS),
        "activeSessions": auth.active_session_count(),
        "warnings": auth.startup_warnings(),
    }
