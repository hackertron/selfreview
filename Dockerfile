FROM oven/bun:1.3.14-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY migrations ./migrations

USER bun
# exec form: bun is PID 1 and receives SIGTERM directly (verified in M0)
CMD ["bun", "src/main.ts"]
