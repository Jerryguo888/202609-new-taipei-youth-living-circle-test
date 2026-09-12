# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Stage 1 — build the Vue 3 + Vite SPA
#
# Build context is the repo root. Note that frontend/vite.config.js sets
# build.outDir to '../dist', so the bundle is emitted to /app/dist (repo root),
# not /app/frontend/dist.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app/frontend

# Copy manifests first so the dependency layer is reused whenever only source
# files change.
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY frontend/ ./

# CARTO basemap key, injected at build time because Vite inlines VITE_* vars
# into the bundle. Empty is a valid build: the basemap falls back to the free,
# watermarked tier (same behaviour as the GitHub Pages workflow).
#
# This value ends up publicly readable in the shipped JS — that is inherent to a
# client-side map key, so restrict it by HTTP referrer in the CARTO dashboard
# rather than treating it as a server-side secret.
ARG VITE_CARTO_KEY=""
ENV VITE_CARTO_KEY=${VITE_CARTO_KEY}

RUN npm run build && test -f /app/dist/index.html

# ---------------------------------------------------------------------------
# Stage 2 — serve the static bundle
#
# nginx-unprivileged runs as UID 101 and listens on 8080, so the container needs
# no root and no CAP_NET_BIND_SERVICE.
# ---------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime

# Config is copied as root, then we drop back to the image's non-root user.
USER root
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
# Kept outside conf.d so nginx.conf's `include /etc/nginx/conf.d/*.conf` does
# not pick the snippet up as a standalone server config.
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
RUN nginx -t
USER 101

EXPOSE 8080

# busybox wget ships with the alpine base, so no extra package is needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
