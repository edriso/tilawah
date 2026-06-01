# syntax=docker/dockerfile:1
#
# Image for the Tilawah Telegram bot. It runs from TypeScript source with tsx
# (the package's `build` is `tsc --noEmit`, so there is no compile step), which
# keeps the setup simple. The verified Quran text file is committed in the
# repo, so the image needs no network to seed.
#
# Migrations and seeding are NOT run here. They run as a one-off step (the
# `tilawah-migrate` compose service) on first deploy and on every push:
#     pnpm db:deploy && pnpm db:seed
# Both are idempotent. The bot refuses to start until the text is seeded.

FROM node:22-slim
WORKDIR /app

# openssl: Prisma's CLI engines (migrate/seed) need libssl, which node:22-slim
# omits; without it Prisma warns and guesses. ca-certificates: TLS roots.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the pinned pnpm GLOBALLY rather than via corepack. The CMD is
# `pnpm start`, so pnpm runs at container startup; with corepack that triggers
# an interactive "download pnpm?" prompt for the runtime `node` user, which
# hangs a detached (`up -d`) container. A global pnpm needs no download. The
# pin (10.33.0) also avoids the newer pnpm's supply-chain release-age gate.
RUN npm install -g pnpm@10.33.0

# Copy manifests first so `pnpm install` is cached when only source changes.
# The postinstall hook runs `prisma generate`, which needs the schema/config.
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# Install ALL dependencies (not --prod): the migrate service needs the `prisma`
# CLI (a devDependency), and the runtime needs tsx. Both would be dropped by
# --prod. We set NODE_ENV to production AFTER this so the install skips nothing.
RUN pnpm install --frozen-lockfile

# Copy the rest of the source (including the committed Quran data file). The
# generated Prisma client (**/generated/) is excluded via .dockerignore and was
# just created by the postinstall above, so this copy leaves it intact.
COPY . .

# Regenerate the Prisma client against the final source tree. The install step
# already generates it, but regenerating here makes the image independent of
# COPY ordering and guarantees it matches the committed schema.
RUN pnpm db:generate

# This image is the production artifact, so default to production for runtime.
ENV NODE_ENV=production

# Drop root for runtime. The bot writes nothing to disk; logs go to stdout.
USER node

# Liveness: hit the in-process /health server so an orchestrator can tell a
# wedged bot from a healthy one and restart it. Uses node's built-in fetch (no
# curl in the slim image). PORT matches what health.ts binds (default 8080).
# The start period covers the boot wait for the database and the seed check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Long-polling bot: no inbound port needed (the /health server binds PORT).
CMD ["pnpm", "start"]
