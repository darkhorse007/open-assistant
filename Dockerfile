ARG BUN_IMAGE=oven/bun:1.3.6

FROM ${BUN_IMAGE} AS base
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies (workspace-aware).
# Keep layer cache stable by copying only package manifests + lockfile first.
COPY package.json bun.lock tsconfig.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY services/asr/package.json ./services/asr/package.json
COPY services/asr-mock/package.json ./services/asr-mock/package.json
COPY services/gateway/package.json ./services/gateway/package.json
COPY services/media/package.json ./services/media/package.json
COPY services/media-mock/package.json ./services/media-mock/package.json
COPY services/rag/package.json ./services/rag/package.json
COPY services/rag-mock/package.json ./services/rag-mock/package.json
COPY services/tts/package.json ./services/tts/package.json
COPY services/tts-mock/package.json ./services/tts-mock/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json

RUN bun install --frozen-lockfile --production

# Copy source (excluding via .dockerignore).
COPY . .

# Default command (overridden by docker compose per-service).
CMD ["bun", "--cwd", "services/gateway", "src/index.ts"]
