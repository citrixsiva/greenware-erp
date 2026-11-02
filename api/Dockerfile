# =============================================================================
# Greenware ERP — API production image
#
# BUILD CONTEXT IS THE REPO ROOT, not api/:
#     docker build -f api/Dockerfile -t greenware-erp-api:local .
# The API is an npm workspace, so the root package.json + package-lock.json are
# the only authoritative dependency manifest for it.
#
# Targets:
#   tooling  — devDependencies + TypeScript sources. Used by the `seed` service
#              in docker-compose.yml, because `npm -w api run seed` runs
#              `tsx src/db/seed.ts` and needs both.
#   runtime  — the default. Production dependencies only, non-root, NODE_ENV=production.
# =============================================================================

# Alpine is safe here: the `argon2` package ships a musl prebuild inside its own
# npm tarball (prebuilds/linux-x64/argon2.musl.node), so no node-gyp toolchain,
# python3 or compiler is needed in any stage. Verified by inspecting the tarball.
FROM node:22-alpine3.20 AS deps
WORKDIR /app

# --- the lockfile workaround -------------------------------------------------
# The committed root package-lock.json covers ONLY the `api` workspace; `web`
# carries its own web/package-lock.json. With both workspaces declared at the
# root, `npm ci` aborts ("Missing: @esbuild/win32-x64 from lock file").
# Narrowing the workspace list for this image keeps `npm ci` reproducible
# instead of falling back to a lock-mutating `npm install`.
# DELETE THESE TWO LINES once the root lockfile is regenerated and committed.
COPY package.json package-lock.json ./
RUN node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));p.workspaces=['api'];fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"

COPY api/package.json ./api/package.json
RUN npm ci --no-audit --no-fund

# -----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY api/tsconfig.json ./api/tsconfig.json
COPY api/src ./api/src
# tsc -p api/tsconfig.json → api/dist (rootDir src, outDir dist)
RUN npm -w api run build

# -----------------------------------------------------------------------------
# `tooling`: devDependencies (tsx) + sources. Migrations/seed/one-off scripts.
FROM build AS tooling
ENV NODE_ENV=development
WORKDIR /app/api
USER node
CMD ["npm", "run", "seed"]

# -----------------------------------------------------------------------------
FROM node:22-alpine3.20 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e "const fs=require('fs'),p=JSON.parse(fs.readFileSync('package.json','utf8'));p.workspaces=['api'];fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
COPY api/package.json ./api/package.json
# --omit=dev: typescript, tsx and @types/* must not exist in the final layer.
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# -----------------------------------------------------------------------------
FROM node:22-alpine3.20 AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DOCUMENT_STORE_DIR=/app/storage

# dumb-init so Fastify receives SIGTERM as PID 1's child and shuts down cleanly.
RUN apk add --no-cache dumb-init

WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=build     --chown=node:node /app/api/package.json ./api/package.json
COPY --from=build     --chown=node:node /app/api/dist ./api/dist

# api/src/modules/documents.ts writes generated RFQ/quotation documents here.
# In compose this path is a named volume; on a droplet it is a bind mount.
RUN mkdir -p /app/storage && chown -R node:node /app/storage

USER node
WORKDIR /app/api
EXPOSE 8080

# Node 22 has global fetch, so the healthcheck needs no curl in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
