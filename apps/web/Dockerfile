# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/sync-worker/package.json ./apps/sync-worker/package.json

RUN npm ci --ignore-scripts --workspace=@clairflux/web --workspace=@clairflux/shared --include-workspace-root \
    || npm install --ignore-scripts --no-audit --no-fund --workspace=@clairflux/web --workspace=@clairflux/shared --include-workspace-root

COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

ARG VITE_API_BASE_URL=/api
ARG VITE_APP_VERSION=1.0.0
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_APP_VERSION=${VITE_APP_VERSION}

RUN npm run build --workspace=@clairflux/web

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner

USER root

RUN cat <<'EOF' > /etc/nginx/conf.d/default.conf
server {
  listen 8080;
  server_name _;
  server_tokens off;

  root /usr/share/nginx/html;
  index index.html;

  gzip on;
  gzip_vary on;
  gzip_min_length 512;
  gzip_types
    text/plain
    text/css
    application/javascript
    application/json
    image/svg+xml
    font/woff2;

  location = /index.html {
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
  }

  location /assets/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
  }

  location / {
    try_files $uri /index.html;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
  }
}
EOF
RUN chmod 644 /etc/nginx/conf.d/default.conf

COPY --from=builder --chown=101:101 /app/apps/web/dist /usr/share/nginx/html

USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
