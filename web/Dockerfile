# =============================================================================
# Greenware ERP — web client production image
#
# BUILD CONTEXT IS THE REPO ROOT, not web/:
#     docker build -f web/Dockerfile -t greenware-erp-web:local .
#
# Targets:
#   dist     — only web/dist. Useful for `docker build --target dist --output`
#              and for DigitalOcean App Platform static sites, which copy the
#              built assets out of the image rather than running it.
#   runtime  — the default. Unprivileged nginx serving the SPA and proxying
#              /api to the API container on the same origin.
# =============================================================================

FROM node:22-alpine3.20 AS build
WORKDIR /app/web

# web/ has its OWN complete lockfile (web/package-lock.json). Copying web/
# alone — without the root package.json — makes it a standalone project, so
# `npm ci` here is reproducible and sidesteps the broken root workspace lock.
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src

# `npm run build` is `tsc --noEmit && vite build`, so a type error fails the image.
ENV NODE_ENV=production
RUN npm run build && test -f dist/index.html

# -----------------------------------------------------------------------------
# Assets only. Nothing from node_modules and no toolchain reaches this stage.
FROM scratch AS dist
COPY --from=build /app/web/dist /

# -----------------------------------------------------------------------------
# nginx-unprivileged runs as uid 101 and binds :8080 — non-root without the
# writable-directory and capability contortions the stock nginx image needs.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

ENV NODE_ENV=production \
    API_UPSTREAM=api:8080

# Rendered into /etc/nginx/conf.d/web.conf at container start by the image's
# own 20-envsubst-on-templates.sh entrypoint script.
COPY --chown=nginx:nginx infra/nginx/web.conf.template /etc/nginx/templates/web.conf.template

# The stock default server also listens on 8080 and would shadow ours.
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
USER nginx

COPY --from=build --chown=nginx:nginx /app/web/dist /usr/share/nginx/html

EXPOSE 8080

# busybox wget is in the base image; no extra package needed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "-", "http://127.0.0.1:8080/healthz"]
