# syntax=docker/dockerfile:1

# The renderer is built here so the runtime image carries no build toolchain and
# no dependency tree: server/ and core/ import nothing but node: builtins.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build


FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# The health assistant shells out to the `claude` CLI. It is installed here; the
# login it uses is bind-mounted from the host (see compose.yml) because OpenFit
# never stores an API key and the CLI reuses its own local login.
RUN npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force \
  && mkdir -p /home/node/.claude \
  && chown -R node:node /home/node

WORKDIR /app
COPY package.json ./
COPY core ./core
COPY server ./server
COPY --from=build /app/dist ./dist

# /data is a bind mount of the host data directory, which is 0700 uid 1000; the
# node user is uid 1000 in this image, so the two line up without a chown.
USER node
ENV OPENFIT_DATA_DIR=/data \
    OPENFIT_HOST=0.0.0.0 \
    OPENFIT_PORT=7788

EXPOSE 7788

# An unauthenticated GET / is the server-rendered sign-in page, so 200 here means
# the process is listening and serving, without needing a credential.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7788/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server/bin.cjs"]
