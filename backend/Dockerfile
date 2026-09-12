# syntax=docker/dockerfile:1.7

FROM python:3.12-slim

# 不寫 .pyc、輸出不緩衝（否則 docker logs 看不到即時日誌）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

COPY app.py .

# 以非 root 執行。8000 是非特權埠，不需要額外 capability。
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8000

# 只驗證服務本身，不打 AWS，避免 healthcheck 因為雲端問題誤判容器壞掉。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
