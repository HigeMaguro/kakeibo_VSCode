FROM node:22-alpine

# GitHub Actions (.github/workflows/docker-publish.yml) から渡される。
# /api/version と「データ管理」ページで稼働中バージョンを確認できる。
ARG APP_VERSION=dev
ARG BUILD_DATE=unknown
ENV APP_VERSION=${APP_VERSION}
ENV BUILD_DATE=${BUILD_DATE}

LABEL org.opencontainers.image.title="MyKakeibo" \
      org.opencontainers.image.source="https://github.com/HigeMaguro/kakeibo_VSCode" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}"

WORKDIR /app

ENV NODE_ENV=production
ENV APP_PORT=80
ENV DB_PATH=/app/data/kakeibo.db
ENV TZ=Asia/Tokyo

# タイムゾーン設定 & ヘルスチェック用の wget/tzdata
RUN apk add --no-cache tzdata wget \
    && cp /usr/share/zoneinfo/Asia/Tokyo /etc/localtime \
    && echo "Asia/Tokyo" > /etc/timezone

# 依存関係 (package-lock.json 固定で再現性のあるインストール。ピュア JS & node:sqlite)
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ソースコード・静的アセット
COPY server.js ./
COPY server ./server
COPY scripts ./scripts
COPY app ./app

# データ永続化ディレクトリ (docker-compose で ./data, ./backups をマウントする)
RUN mkdir -p /app/data /app/backups
VOLUME ["/app/data", "/app/backups"]

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

CMD ["node", "server.js"]
