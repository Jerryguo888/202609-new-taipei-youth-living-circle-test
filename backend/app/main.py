"""FastAPI 應用組裝點。

只做三件事：建立 app、掛上各層的 router、啟動時把設定問題印出來。
實際邏輯都在各自的模組裡，這樣要知道「有哪些端點」看這一支就夠了。

    app/routes.py       /api/health, /api/meta/*, /api/metrics/*, /api/records/*
    app/ai/chat.py      /api/chat
    app/admin/routes.py /api/admin/*
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI

from app import routes
from app.admin import routes as admin_routes
from app.ai import chat

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("living-circle-chat")

app = FastAPI(title="Living Circle Chat", docs_url=None, redoc_url=None)

app.include_router(routes.router)
app.include_router(chat.router)
# 後台 API（/api/admin/*）。除了登入之外每個路由都要通過驗證。
app.include_router(admin_routes.router)
admin_routes.install_error_handlers(app)


@app.on_event("startup")
def _log_startup_warnings() -> None:
    from app.admin import auth

    for warning in auth.startup_warnings():
        logger.warning("%s", warning)
