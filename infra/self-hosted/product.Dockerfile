# WP32 — self-hosted product imajı (ADR-0032).
# wp30 product imajının dağıtım uyarlaması: web bundle'ı domain-agnostik placeholder
# origin ile üretilir (self-hosted-web-server.mjs açılışta kanonik origin'i yazar),
# bootstrap bundle'ı eklenir, SOURCE_DATE_EPOCH ile deterministik kurulur.
# Multi-arch: base imaj digest'i çok mimarili index digest'idir; linux/amd64 ve
# linux/arm64 build'leri `wp32:release-build` (buildx) ile üretilir.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
ARG SOURCE_DATE_EPOCH=1753056000
# WP38 (ADR-0038): base-path build-time'dır (Vite base build-arg ile iner);
# boş değer = kök ve bugünkü çıktıyla bire bir aynıdır. Origin ikamesi
# runtime'da kalır (self-hosted-web-server.mjs).
ARG SELF_HOSTED_BASE_PATH=
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@9.15.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps apps
COPY agents agents
COPY packages packages
COPY services services
COPY config config
COPY infra/self-hosted/bootstrap infra/self-hosted/bootstrap
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec esbuild services/control-plane/src/production-api-process.ts --bundle --platform=node --format=esm --external:pg-native --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/control-plane.mjs \
 && pnpm exec esbuild services/control-plane/src/production-worker-process.ts --bundle --platform=node --format=esm --external:pg-native --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/workspace-agent.mjs \
 && pnpm exec esbuild infra/self-hosted/bootstrap/self-hosted-bootstrap.ts --bundle --platform=node --format=esm --external:pg-native --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=/out/self-hosted-bootstrap.mjs \
 && VITE_BASE_PATH="${SELF_HOSTED_BASE_PATH}" VITE_CONTROL_PLANE_URL=https://public-origin.invalid pnpm --filter @perseverance/web build \
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
ARG SOURCE_DATE_EPOCH=1753056000
LABEL org.opencontainers.image.title="perseverance-self-hosted-product" \
      org.opencontainers.image.description="Perseverance self-hosted product image (WP32)" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.created="2026-07-21T00:00:00Z"
RUN addgroup -S workspace && adduser -S -G workspace -u 10001 workspace
# WP36 gerçek-ortam bulgusu: codex-home named volume'u ilk mount'ta imajdaki
# dizin sahipliğini devralır. Dizin imajda yokken root sahipliğiyle oluşuyor ve
# uid 10001 ile koşan workspace-agent içindeki codex login /codex-home'a
# yazamıyordu (gate'ler görmedi çünkü provider auth hep defer edilmişti).
RUN mkdir -p /codex-home && chown 10001:10001 /codex-home
WORKDIR /app
COPY --from=build --chown=10001:10001 /out ./
COPY --chown=10001:10001 infra/self-hosted/web/self-hosted-web-server.mjs ./self-hosted-web-server.mjs
USER 10001:10001
ENV WP26_CODEX_BIN=/app/codex/bin/codex.js
CMD ["node", "control-plane.mjs"]
