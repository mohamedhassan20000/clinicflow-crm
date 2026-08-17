# ClinicFlow WhatsApp linked-device worker.
#
# The build context is THIS directory (services/whatsapp-worker), not the
# repository root: the worker has its own dependency tree and must never drag a
# copy of the Next.js application into its image. On Railway that means setting
# the service's root directory to `services/whatsapp-worker`.
#
# Debian slim rather than Alpine on purpose: Baileys pulls in prebuilt native
# binaries (sharp/libvips among them) that ship glibc builds by default, and a
# musl base turns a working install into a runtime surprise.

# ---------------------------------------------------------------------------
# Build — full dependency tree, compiled to dist/
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Manifests first so a source-only change reuses the cached install layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Production dependencies — resolved separately so devDependencies (typescript,
# @types/*) never reach the final image.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Never run the worker as root: it holds the Supabase service role and every
# clinic's device identity.
USER node

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

# Documentation only — the process binds process.env.PORT, which Railway injects.
EXPOSE 8080

# Signals must reach Node itself: the worker's SIGTERM handler is what closes
# the WhatsApp sockets cleanly on a redeploy, and a shell wrapper would swallow
# it. Exec form, no shell, no init needed.
CMD ["node", "dist/index.js"]
