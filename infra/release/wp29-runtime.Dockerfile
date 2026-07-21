FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
ARG SOURCE_DATE_EPOCH=1753056000
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agents/workspace-agent/package.json agents/workspace-agent/package.json
COPY packages packages
COPY agents/workspace-agent/src agents/workspace-agent/src
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm exec esbuild agents/workspace-agent/src/index.ts --bundle --platform=node --format=esm --outfile=/out/workspace-agent.mjs

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
ARG SOURCE_DATE_EPOCH=1753056000
LABEL org.opencontainers.image.source="persistent-codex-workspace" \
      org.opencontainers.image.created="2026-07-21T00:00:00Z"
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && addgroup -S workspace \
    && adduser -S -G workspace -u 10001 workspace
WORKDIR /workspace
COPY --from=build --chown=10001:10001 /out/workspace-agent.mjs ./workspace-agent.mjs
USER 10001:10001
ENTRYPOINT ["node", "workspace-agent.mjs"]
