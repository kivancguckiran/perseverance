#!/usr/bin/env bash
# Same-host self-hosted deployment submitter.
#
# Resolve an already-pushed commit on the installation host, create a clean
# detached release checkout, and start the idle-aware deployment worker. The
# worker delegates backup/build/migration/restart to self-hosted.sh.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" = "--" ]]; then
  shift
fi
DEPLOY_REF="${1:-HEAD}"
[[ "$#" -le 1 ]] || {
  printf '[self-hosted-deploy] HATA: yalnız bir git ref kabul edilir\n' >&2
  exit 1
}

LOCAL_CONFIG="${PERSISTENT_DEPLOY_CONFIG_FILE:-${ROOT_DIR}/config/local/self-hosted-deploy.sh}"
if [[ -f "${LOCAL_CONFIG}" ]]; then
  # Trusted, operator-owned shell configuration. The tracked example uses
  # default assignments so explicit process environment values win.
  set -a
  # shellcheck disable=SC1090
  source "${LOCAL_CONFIG}"
  set +a
fi

DEPLOY_ROOT="${PERSISTENT_DEPLOY_ROOT:-}"
STATE_HOME="${PERSISTENT_DEPLOY_STATE_HOME:-/var/lib/perseverance}"
IDLE_SECONDS="${PERSISTENT_DEPLOY_IDLE_SECONDS:-3600}"
POLL_SECONDS="${PERSISTENT_DEPLOY_POLL_SECONDS:-60}"

log() { printf '[self-hosted-deploy] %s\n' "$*"; }
fail() {
  printf '[self-hosted-deploy] HATA: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-self-hosted.sh [<git-ref>]

Run this command on the host where Perseverance is installed. Machine-specific
values are loaded from:
  config/local/self-hosted-deploy.sh

Copy the tracked template first:
  cp config/local.example/self-hosted-deploy.sh config/local/self-hosted-deploy.sh

Environment overrides:
  PERSISTENT_DEPLOY_CONFIG_FILE=/path/to/self-hosted-deploy.sh
  PERSISTENT_DEPLOY_ROOT=/srv/perseverance
  PERSISTENT_DEPLOY_STATE_HOME=/var/lib/perseverance
  PERSISTENT_DEPLOY_IDLE_SECONDS=3600
  PERSISTENT_DEPLOY_POLL_SECONDS=60
EOF
}

case "${DEPLOY_REF}" in
--help | -h)
  usage
  exit 0
  ;;
esac

[[ -n "${DEPLOY_ROOT}" ]] ||
  fail "PERSISTENT_DEPLOY_ROOT gerekli; config/local.example şablonunu kopyalayın"
command -v realpath >/dev/null 2>&1 || fail "realpath bulunamadı"
canonical_host_path() {
  local raw="$1" parent resolved
  [[ "${raw}" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "güvensiz host path: ${raw}"
  [[ ! "${raw}" =~ (^|/)\.\.(/|$) ]] || fail "host path '..' içeremez: ${raw}"
  [[ "${raw}" != */ ]] || fail "host path trailing slash içeremez: ${raw}"
  case "${raw}" in
  /proc | /proc/* | /sys | /sys/*) fail "yasak host path: ${raw}" ;;
  esac
  if [[ -e "${raw}" ]]; then
    resolved="$(realpath "${raw}")" || fail "host path çözümlenemedi: ${raw}"
  else
    parent="$(dirname "${raw}")"
    [[ -d "${parent}" ]] || fail "host path parent dizini yok: ${parent}"
    resolved="$(realpath "${parent}")/$(basename "${raw}")"
  fi
  [[ "${resolved}" = "${raw}" ]] ||
    fail "host path symlink veya canonical olmayan bileşen içeriyor: ${raw}"
  printf '%s\n' "${resolved}"
}
DEPLOY_ROOT="$(canonical_host_path "${DEPLOY_ROOT}")"
STATE_HOME="$(canonical_host_path "${STATE_HOME}")"
[[ "${DEPLOY_ROOT}" != "${STATE_HOME}" ]] ||
  fail "deploy root ile state home ayrı dizinler olmalı"
[[ "${IDLE_SECONDS}" =~ ^[0-9]+$ ]] &&
  ((IDLE_SECONDS >= 60 && IDLE_SECONDS <= 604800)) ||
  fail "PERSISTENT_DEPLOY_IDLE_SECONDS 60..604800 aralığında olmalı"
[[ "${POLL_SECONDS}" =~ ^[0-9]+$ ]] &&
  ((POLL_SECONDS >= 5 && POLL_SECONDS <= 3600)) ||
  fail "PERSISTENT_DEPLOY_POLL_SECONDS 5..3600 aralığında olmalı"

command -v git >/dev/null 2>&1 || fail "Git bulunamadı"
command -v docker >/dev/null 2>&1 || fail "Docker CLI bulunamadı"
docker info >/dev/null 2>&1 || fail "Docker daemon erişilemiyor"

cd "${ROOT_DIR}"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] ||
  fail "kaynak worktree temiz değil; deploy öncesi commit/stash gerekli"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SELF_HOSTED_HOME="${STATE_HOME}"
export GIT_TERMINAL_PROMPT=0

git fetch --quiet --prune origin
TARGET_SHA="$(git rev-parse "${DEPLOY_REF}^{commit}")" ||
  fail "git ref çözümlenemedi: ${DEPLOY_REF}"
[[ "${TARGET_SHA}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "çözümlenen commit geçersiz: ${TARGET_SHA}"
git branch -r --contains "${TARGET_SHA}" | grep -qE '^[[:space:]]*origin/' ||
  fail "${TARGET_SHA} origin'e push edilmemiş"

release_root="${DEPLOY_ROOT}/releases"
env_file="${STATE_HOME}/config/self-hosted.env"
release_state_file="${STATE_HOME}/state/current-release.env"
target_release="${release_root}/${TARGET_SHA}"
incoming=""

read_env() { sed -n "s/^$1=//p" "${env_file}" | tail -n 1; }
validate_release() {
  local release="$1" expected_sha="$2"
  [[ -d "${release}/.git" ]] || return 1
  [[ "$(git -C "${release}" rev-parse HEAD)" = "${expected_sha}" ]] || return 1
  [[ -z "$(git -C "${release}" branch --show-current)" ]] || return 1
  [[ -z "$(git -C "${release}" status --porcelain)" ]] || return 1
}

[[ -f "${env_file}" ]] || fail "self-hosted env bulunamadı: ${env_file}"
[[ -f "${release_state_file}" ]] ||
  fail "tamamlanmış release state bulunamadı: ${release_state_file}"
mkdir -p "${release_root}"

current_sha="$(read_env SELF_HOSTED_SOURCE_COMMIT)"
[[ "${current_sha}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "mevcut SELF_HOSTED_SOURCE_COMMIT geçersiz"
completed_sha="$(sed -n 's/^SELF_HOSTED_SOURCE_COMMIT=//p' "${release_state_file}" | tail -n 1)"
[[ "${completed_sha}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "current-release.env commit'i geçersiz"
[[ "${current_sha}" = "${completed_sha}" ]] ||
  fail "env commit'i (${current_sha}) tamamlanmış release state'iyle (${completed_sha}) eşleşmiyor; önce yarım kalmış deploy'u inceleyin"
source_release="${release_root}/${current_sha}"
validate_release "${source_release}" "${current_sha}" ||
  fail "mevcut release temiz/detached/exact değil: ${source_release}"

preserve_failed_checkout() {
  if [[ -n "${incoming}" && -d "${incoming}" ]]; then
    failed="${release_root}/.failed-${TARGET_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "${incoming}" "${failed}"
    log "tamamlanmamış checkout korundu: ${failed}"
  fi
}
trap preserve_failed_checkout EXIT

if [[ -e "${target_release}" ]]; then
  validate_release "${target_release}" "${TARGET_SHA}" ||
    fail "hedef release mevcut ama temiz/detached/exact değil: ${target_release}"
  log "hedef detached release zaten hazır"
else
  incoming="${release_root}/.incoming-${TARGET_SHA}-$$"
  [[ ! -e "${incoming}" ]] || fail "incoming release yolu dolu: ${incoming}"
  origin_url="$(git remote get-url origin)"
  log "aynı hostta bağımsız release checkout oluşturuluyor"
  git clone --no-hardlinks --no-checkout "${ROOT_DIR}" "${incoming}"
  git -C "${incoming}" remote set-url origin "${origin_url}"
  git -C "${incoming}" fetch --prune origin \
    '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
  git -C "${incoming}" cat-file -e "${TARGET_SHA}^{commit}"
  git -C "${incoming}" checkout --detach "${TARGET_SHA}"
  validate_release "${incoming}" "${TARGET_SHA}" ||
    fail "oluşturulan release doğrulanamadı"
  mv "${incoming}" "${target_release}"
  incoming=""
fi

deploy_state_dir="${STATE_HOME}/state"
mkdir -p "${deploy_state_dir}"
umask 077
# Retain the established state filename so an already-running worker from the
# previous submitter cannot race a new same-host submission.
pending_file="${deploy_state_dir}/pending-remote-deploy.env"
pending_tmp="${pending_file}.tmp.$$"
{
  printf 'TARGET_SHA=%s\n' "${TARGET_SHA}"
  printf 'REQUESTED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'IDLE_SECONDS=%s\n' "${IDLE_SECONDS}"
  printf 'POLL_SECONDS=%s\n' "${POLL_SECONDS}"
} >"${pending_tmp}"
mv "${pending_tmp}" "${pending_file}"

worker_script="${target_release}/scripts/run-pending-self-hosted-deploy.sh"
[[ -f "${worker_script}" ]] || fail "deploy worker bulunamadı: ${worker_script}"
worker_log="${deploy_state_dir}/remote-deploy-worker.log"
nohup bash "${worker_script}" "${DEPLOY_ROOT}" "${STATE_HOME}" \
  >>"${worker_log}" 2>&1 </dev/null &

log "deploy kuyruğa alındı: commit=${TARGET_SHA} idle=${IDLE_SECONDS}s"
log "worker başlatıldı; log: ${worker_log}"
