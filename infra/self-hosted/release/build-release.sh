#!/usr/bin/env bash
# WP32 — çok mimarili self-hosted release üretimi (ADR-0032, wp29 hattı).
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
RELEASE_VERSION=1.0.0
SOURCE_DATE_EPOCH=1785369600
export SOURCE_DATE_EPOCH

mkdir -p "${OUTPUT}"
OUTPUT="$(cd "${OUTPUT}" && pwd)"

echo "[release] multi-arch product imajı build ediliyor (${PLATFORMS})"
docker buildx build \
  --platform "${PLATFORMS}" \
  --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
  -f "${SELF_HOSTED_DIR}/product.Dockerfile" \
  -o "type=oci,dest=${OUTPUT}/product-oci.tar,tar=true" \
  -t "perseverance-self-hosted-product:${SOURCE_COMMIT}" \
  "${REPO_ROOT}"

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
  infra/self-hosted infra/postgres/migrations

echo "[release] release-manifest.json üretiliyor"
NODE_IMAGE="$(sed -n 's/^SELF_HOSTED_NODE_IMAGE=//p' "${SELF_HOSTED_DIR}/images.env")"
docker run --rm -v "${OUTPUT}:/out" -e "SOURCE_COMMIT=${SOURCE_COMMIT}" \
  -e "RELEASE_VERSION=${RELEASE_VERSION}" \
  -e "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" "${NODE_IMAGE}" node -e '
  const { createHash } = require("node:crypto")
  const { readFileSync, writeFileSync, readdirSync } = require("node:fs")
  const sha256 = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex")
  const artifacts = ["product-oci.tar", "self-hosted-dist.tar"].map((name) => ({
    name,
    sha256: sha256(`/out/${name}`),
  }))
  const manifest = {
    schemaVersion: 1,
    repository: "perseverance",
    releaseVersion: process.env.RELEASE_VERSION,
    sourceCommit: process.env.SOURCE_COMMIT,
    sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH),
    platforms: ["linux/amd64", "linux/arm64"],
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
        buildType: "https://perseverance.invalid/wp32/self-hosted-release/v1",
        externalParameters: {
          repository: "perseverance",
          releaseVersion: process.env.RELEASE_VERSION,
          sourceCommit: process.env.SOURCE_COMMIT,
        },
      },
      runDetails: { builder: { id: "wp32-self-hosted-release-builder-v1" } },
    },
  }
  writeFileSync("/out/provenance.intoto.json", JSON.stringify(provenance, null, 2) + "\n")
  const validUntil = new Date((Number(process.env.SOURCE_DATE_EPOCH) + 90 * 24 * 3600) * 1000)
  writeFileSync("/out/trust-policy.json", JSON.stringify({
    repository: "perseverance",
    releaseVersion: process.env.RELEASE_VERSION,
    sourceCommit: process.env.SOURCE_COMMIT,
    validUntil: validUntil.toISOString(),
    revoked: false,
  }, null, 2) + "\n")
'

(cd "${OUTPUT}" && sha256sum product-oci.tar self-hosted-dist.tar \
  release-manifest.json provenance.intoto.json trust-policy.json >SHA256SUMS)

if [ -n "${COSIGN_KEY_FILE:-}" ]; then
  [ -n "${COSIGN_PUB_FILE:-}" ] || fail "COSIGN_KEY_FILE ile birlikte COSIGN_PUB_FILE gerekli"
  COSIGN_IMAGE="$(sed -n 's/^SELF_HOSTED_COSIGN_IMAGE=//p' "${SELF_HOSTED_DIR}/images.env")"
  cp "${COSIGN_PUB_FILE}" "${OUTPUT}/cosign.pub"
  echo "[release] cosign imzaları üretiliyor"
  for artifact in product-oci.tar self-hosted-dist.tar release-manifest.json \
    provenance.intoto.json trust-policy.json; do
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
  echo "[release] Yayın öncesi 'pnpm wp29:signatures' hattındaki anahtar yönetimiyle imzalayın."
fi

echo "[release] tamam — sourceCommit ${SOURCE_COMMIT}"
