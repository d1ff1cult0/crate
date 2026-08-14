# Worker image. ffmpeg/fpcalc/yt-dlp are RUNTIME dependencies of the postprocess and
# fingerprint queues — a worker without them boots fine and fails at job time, which is
# a bad failure mode. Install them here. (docs/DECISIONS.md A6)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libchromaprint-tools \
      python3 \
      ca-certificates \
      curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/integrations/package.json packages/integrations/
COPY packages/providers/package.json packages/providers/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm --filter @crate/db generate

# Fail fast if the audio tooling is missing rather than at first job.
RUN ffprobe -version >/dev/null && fpcalc -version >/dev/null

# Apply migrations before the worker starts, and ONLY here — the web container must not
# also run them, or two containers race for the migration lock on every deploy.
#
# `migrate deploy` is the non-interactive path: it applies pending migrations and never
# resets or prompts. It is idempotent, so a restart with nothing pending is a no-op.
# Without this a shipped migration only lands if someone remembers to run it by hand,
# and the failure that follows looks like an application bug rather than a missed step.
CMD ["sh", "-c", "cd packages/db && npx prisma migrate deploy && cd /app && pnpm --filter @crate/worker start"]
