FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/integrations/package.json packages/integrations/
COPY packages/providers/package.json packages/providers/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm --filter @crate/db generate
RUN pnpm --filter @crate/web build

EXPOSE 3000
CMD ["pnpm", "--filter", "@crate/web", "start"]
