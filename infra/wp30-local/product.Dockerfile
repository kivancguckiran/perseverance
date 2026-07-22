FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps apps
COPY agents agents
COPY packages packages
COPY services services
COPY config config
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec esbuild services/control-plane/src/production-api-process.ts --bundle --platform=node --format=esm --external:pg-native --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/control-plane.mjs \
 && pnpm exec esbuild services/control-plane/src/production-worker-process.ts --bundle --platform=node --format=esm --external:pg-native --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/workspace-agent.mjs \
 && VITE_CONTROL_PLANE_URL=http://127.0.0.1:3300 pnpm --filter @persistent-codex/web build \
 && pnpm exec esbuild apps/web/dist/server/server.js --bundle --platform=node --format=esm --outfile=/out/web-server.mjs \
 && mkdir -p /out/web \
 && cp -R apps/web/dist/client /out/web/client \
 && mkdir -p /out/codex \
 && cp -LR node_modules/@openai/codex/. /out/codex/ \
 && vendor_path="$(find node_modules/.pnpm -path '*codex*linux*/vendor' -type d | head -n 1)" \
 && test -n "$vendor_path" \
 && cp -R "$vendor_path" /out/codex/vendor \
 && chmod +x /out/codex/bin/codex.js /out/codex/vendor/*/bin/codex

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
RUN addgroup -S workspace && adduser -S -G workspace -u 10001 workspace
WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./
COPY --chown=10001:10001 infra/wp30-local/web-production-server.mjs ./web-production-server.mjs
USER 10001:10001
ENV WP26_CODEX_BIN=/app/codex/bin/codex.js
CMD ["node", "control-plane.mjs"]
