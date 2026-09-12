# syntax=docker/dockerfile:1.7

FROM python:3.12-slim

# 不寫 .pyc、輸出不緩衝（否則 docker logs 看不到即時日誌）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# /srv 而不是 /app：套件本身就叫 app，用 /app 會變成 /app/app 那種路徑。
WORKDIR /srv

# app.main:app 要 import 得到 app 套件。設 PYTHONPATH 讓
# 「python scripts/xxx.py」也能直接跑，不必改成 python -m。
ENV PYTHONPATH=/srv

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

COPY data_sources.yaml ./
COPY app/ ./app/
COPY scripts/ ./scripts/
# 指標快照：本機／降級時的數值來源，也是 Athena 不通時的退路。
# 正式環境由季度作業產出新版上傳 S3，這裡先烘一份進 image 保證開箱可用。
COPY curated/ ./curated/

# 以非 root 執行。8000 是非特權埠，不需要額外 capability。
RUN useradd --create-home --uid 10001 appuser

# /data 是每月更新資料掛載進來的位置。這裡先建好並設好 owner 是必要的：
# 具名 volume 第一次掛載時會沿用 image 內該路徑的擁有者，沒有這一步的話
# volume 會是 root 所有，refresh 容器以 appuser 執行就寫不進去。
RUN mkdir -p /data/records && chown -R appuser:appuser /data

USER appuser

EXPOSE 8000

# 只驗證服務本身，不打 AWS，避免 healthcheck 因為雲端問題誤判容器壞掉。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
