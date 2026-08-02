#!/usr/bin/env bash
# Çok mimarili self-hosted release üretimi.
# linux/amd64 + linux/arm64 product imajlarını buildx ile üretir, kurulum
# bundle'ını (compose profili + migration'lar + script'ler) paketler, checksum
# üretir ve COSIGN_KEY_FILE verilmişse cosign ile imzalar + in-toto/SLSA
# provenance ve trust-policy üretir. Çıktı `self-hosted.sh verify-release`
# tarafından fail-closed doğrulanır.
#
# Kullanım:
#   bash infra/self-hosted/release/build-release.sh --output dist/self-hosted-release
#   COSIGN_KEY_FILE=/path/cosign.key COSIGN_PUB_FILE=/path/cosign.pub \
#     bash infra/self-hosted/release/build-release.sh --output dist/release

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_HOSTED_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SELF_HOSTED_DIR}/../.." && pwd)"

PLATFORMS="linux/amd64,linux/arm64"
OUTPUT="${REPO_ROOT}/dist/self-hosted-release"
while [ $# -gt 0 ]; do
  case "$1" in
  --platforms) PLATFORMS="$2" && shift ;;
  --output) OUTPUT="$2" && shift ;;
  *)
    echo "bilinmeyen argüman: $1" >&2
    exit 2
    ;;
  esac
  shift
done

fail() {
  echo "HATA: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker gerekli"
docker buildx version >/dev/null 2>&1 || fail "docker buildx gerekli (multi-arch build)"
[ -z "$(git -C "${REPO_ROOT}" status --porcelain)" ] ||
  fail "release yalnız temiz worktree'den üretilir"
SOURCE_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
RELEASE_VERSION="$(
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' \
    "${REPO_ROOT}/package.json" | head -n 1
)"
[ -n "${RELEASE_VERSION}" ] || fail "package.json version okunamadı"
SOURCE_DATE_EPOCH=1785369600
export SOURCE_DATE_EPOCH

[ ! -d "${OUTPUT}" ] || [ -z "$(find "${OUTPUT}" -mindepth 1 -print -quit)" ] ||
  fail "release output dizini boş olmalı: ${OUTPUT}"
mkdir -p "${OUTPUT}"
OUTPUT="$(cd "${OUTPUT}" && pwd)"

BUILDKIT_IMAGE="$(
  sed -n 's/^SELF_HOSTED_RELEASE_BUILDKIT_IMAGE=//p' "${SELF_HOSTED_DIR}/images.env"
)"
[ -n "${BUILDKIT_IMAGE}" ] || fail "release BuildKit image pin'i eksik"
BUILDER_NAME="perseverance-release-$$"
cleanup_builder() {
  docker buildx rm "${BUILDER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup_builder EXIT
docker buildx create --name "${BUILDER_NAME}" --driver docker-container \
  --driver-opt "image=${BUILDKIT_IMAGE}" >/dev/null
docker buildx inspect --builder "${BUILDER_NAME}" --bootstrap >/dev/null

IFS=',' read -r -a PLATFORM_LIST <<<"${PLATFORMS}"
PRODUCT_ARTIFACTS=()
NORMALIZED_PLATFORMS=()
for platform in "${PLATFORM_LIST[@]}"; do
  case "${platform}" in
  linux/amd64) suffix=linux-amd64 ;;
  linux/arm64) suffix=linux-arm64 ;;
  *) fail "desteklenmeyen release platformu: ${platform}" ;;
  esac
  artifact="product-${suffix}.tar"
  echo "[release] product imajı build ediliyor (${platform} → ${artifact})"
  docker buildx build \
    --builder "${BUILDER_NAME}" \
    --platform "${platform}" \
    --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
    -f "${SELF_HOSTED_DIR}/product.Dockerfile" \
    -o "type=docker,dest=${OUTPUT}/${artifact}" \
    -t "perseverance-self-hosted-product:${SOURCE_COMMIT}" \
    "${REPO_ROOT}"
  PRODUCT_ARTIFACTS+=("${artifact}")
  NORMALIZED_PLATFORMS+=("${platform}")
done
[ "${#PRODUCT_ARTIFACTS[@]}" -gt 0 ] || fail "en az bir platform gerekli"

echo "[release] kurulum bundle'ı paketleniyor"
TAR_IMAGE="$(sed -n 's/^SELF_HOSTED_TAR_IMAGE=//p' "${SELF_HOSTED_DIR}/images.env")"
docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -v "${OUTPUT}:/out" \
  -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
  -w /src \
  "${TAR_IMAGE}" \
  tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
  -cf /out/self-hosted-dist.tar \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json \
  apps agents packages services config third_party NOTICE LICENSE \
  infra/self-hosted infra/postgres/migrations

echo "[release] release-manifest.json üretiliyor"
NODE_IMAGE="$(sed -n 's/^SELF_HOSTED_NODE_IMAGE=//p' "${SELF_HOSTED_DIR}/images.env")"
docker run --rm -v "${OUTPUT}:/out" -e "SOURCE_COMMIT=${SOURCE_COMMIT}" \
  -e "RELEASE_VERSION=${RELEASE_VERSION}" \
  -e "ARTIFACT_NAMES=$(IFS=,; echo "${PRODUCT_ARTIFACTS[*]}"),self-hosted-dist.tar" \
  -e "RELEASE_PLATFORMS=$(IFS=,; echo "${NORMALIZED_PLATFORMS[*]}")" \
  -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" "${NODE_IMAGE}" node -e '
  const { createHash } = require("node:crypto")
  const { readFileSync, writeFileSync } = require("node:fs")
  const sha256 = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex")
  const names = process.env.ARTIFACT_NAMES.split(",").filter(Boolean)
  const artifacts = names.map((name) => ({
    name,
    sha256: sha256(`/out/${name}`),
  }))
  const manifest = {
    schemaVersion: 1,
    repository: "perseverance",
    releaseVersion: process.env.RELEASE_VERSION,
    sourceCommit: process.env.SOURCE_COMMIT,
    sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH),
    platforms: process.env.RELEASE_PLATFORMS.split(",").filter(Boolean),
    artifacts,
  }
  writeFileSync("/out/release-manifest.json", JSON.stringify(manifest, null, 2) + "\n")
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: artifacts.map((artifact) => ({
      name: artifact.name,
      digest: { sha256: artifact.sha256 },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://perseverance.invalid/self-hosted-release/v1",
        externalParameters: {
          repository: "perseverance",
          releaseVersion: process.env.RELEASE_VERSION,
          sourceCommit: process.env.SOURCE_COMMIT,
        },
      },
      runDetails: { builder: { id: "self-hosted-release-builder-v1" } },
    },
  }
  writeFileSync("/out/provenance.intoto.json", JSON.stringify(provenance, null, 2) + "\n")
  const validUntil = new Date((Number(process.env.SOURCE_DATE_EPOCH) + 5 * 365 * 24 * 3600) * 1000)
  writeFileSync("/out/trust-policy.json", JSON.stringify({
    repository: "perseverance",
    releaseVersion: process.env.RELEASE_VERSION,
    sourceCommit: process.env.SOURCE_COMMIT,
    validUntil: validUntil.toISOString(),
    revoked: false,
  }, null, 2) + "\n")
'

CHECKSUM_TARGETS=(
  "${PRODUCT_ARTIFACTS[@]}"
  self-hosted-dist.tar
  release-manifest.json
  provenance.intoto.json
  trust-policy.json
)
(cd "${OUTPUT}" && sha256sum "${CHECKSUM_TARGETS[@]}" >SHA256SUMS)

if [ -n "${COSIGN_KEY_FILE:-}" ]; then
  [ -n "${COSIGN_PUB_FILE:-}" ] || fail "COSIGN_KEY_FILE ile birlikte COSIGN_PUB_FILE gerekli"
  COSIGN_IMAGE="$(sed -n 's/^SELF_HOSTED_COSIGN_IMAGE=//p' "${SELF_HOSTED_DIR}/images.env")"
  cp "${COSIGN_PUB_FILE}" "${OUTPUT}/cosign.pub"
  echo "[release] cosign imzaları üretiliyor"
  for artifact in "${CHECKSUM_TARGETS[@]}"; do
    docker run --rm \
      -v "${OUTPUT}:/work" \
      -v "${COSIGN_KEY_FILE}:/keys/cosign.key:ro" \
      -e "COSIGN_PASSWORD=${COSIGN_PASSWORD:-}" \
      "${COSIGN_IMAGE}" sign-blob --yes --tlog-upload=false \
      --key /keys/cosign.key \
      --output-signature "/work/${artifact}.sig" \
      "/work/${artifact}" >/dev/null
  done
  echo "[release] imzalı bundle hazır: ${OUTPUT}"
else
  echo "[release] UYARI: COSIGN_KEY_FILE verilmedi — bundle imzasız üretildi;"
  echo "[release] imzasız bundle 'self-hosted.sh verify-release' doğrulamasından GEÇMEZ."
  echo "[release] Yayın öncesi COSIGN_KEY_FILE ve COSIGN_PUB_FILE ile yeniden üretin."
fi

echo "[release] tamam — sourceCommit ${SOURCE_COMMIT}"
