# Worker image. ffmpeg/fpcalc/yt-dlp are RUNTIME dependencies of the postprocess and
# fingerprint queues — a worker without them boots fine and fails at job time, which is
# a bad failure mode. Install them here. (docs/DECISIONS.md A6)
FROM node:22-bookworm-slim

# Reviewed immutable upstream release (2026-07-04). Update version and official
# SHA2-256SUMS value together; never replace this with the moving /latest URL.
ARG YT_DLP_VERSION=2026.07.04
ARG YT_DLP_SHA256=495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libchromaprint-tools \
      python3 \
      ca-certificates \
      curl \
    && curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict - \
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
RUN ffprobe -version >/dev/null && fpcalc -version >/dev/null \
    && test "$(yt-dlp --version)" = "${YT_DLP_VERSION}"

CMD ["pnpm", "--filter", "@crate/worker", "start"]
