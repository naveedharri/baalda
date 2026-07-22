# Baalda server — production image.
#
# Build context MUST be the repo root (this Dockerfile reaches into app/ as a
# whole because the server is one workspace of the pnpm monorepo and needs the
# workspace root's package.json + pnpm-lock.yaml + pnpm-workspace.yaml to
# resolve its deps):
#
#   docker build -f app/apps/server/Dockerfile -t baalda-server .
#
# Run (see docs/DEPLOY.md for the full env var reference):
#
#   docker run -p 3010:3010 \
#     -e DATABASE_URL=postgres://... \
#     -e JWT_SECRET=... \
#     -e BETTER_AUTH_URL=https://your-host \
#     baalda-server

# ---- build: install workspace deps, compile, prune to a deployable bundle --
FROM node:22-alpine AS build
# corepack reads the pinned pnpm version from package.json's packageManager
# field, so the build always uses the same pnpm as CI and local dev.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo/app

# Lockfile-only layer first: `pnpm fetch` populates the store from
# pnpm-lock.yaml alone, so dependency downloads are cached until the lockfile
# itself changes — source edits don't re-download anything.
COPY app/package.json app/pnpm-lock.yaml app/pnpm-workspace.yaml ./
RUN pnpm fetch

COPY app/apps/server ./apps/server
COPY app/apps/desktop/package.json ./apps/desktop/package.json
RUN pnpm install --frozen-lockfile --offline --filter server
RUN pnpm --filter server run build
# `pnpm deploy` emits a self-contained server bundle (source + dist +
# migrations + prod-only hard-linked node_modules) that survives a cross-stage
# COPY — and, unlike the old npm layout, contains none of desktop's deps.
# --legacy: neither workspace package depends on the other, so the
# inject-workspace-packages machinery pnpm 10 otherwise requires is moot.
RUN pnpm --filter server --prod deploy --legacy /out

# ---- runtime: node + the deployed bundle, no package manager ---------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./

ENV PORT=3010
EXPOSE 3010

CMD ["node", "dist/index.js"]
