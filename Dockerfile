FROM oven/bun:1.4.4-debian

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    BROWSER_BACKEND=chrome \
    BUN_CHROME_PATH=/usr/bin/chromium \
    TZ=America/Chicago

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates curl fonts-liberation tini tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data \
    && chown -R bun:bun /app /data

WORKDIR /app
USER bun
COPY --chown=bun:bun package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun src/ ./src/
COPY --chown=bun:bun web/ ./web/

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/index.ts"]
