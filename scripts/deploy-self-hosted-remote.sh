#!/usr/bin/env bash
# Generic self-hosted remote deployment wrapper.
#
# Resolves an already-pushed commit, creates a clean detached release checkout
# over the configured SSH transport, and delegates backup/build/migration/restart to the
# canonical infra/self-hosted/self-hosted.sh lifecycle command.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" = "--" ]]; then
  shift
fi
DEPLOY_REF="${1:-HEAD}"
[[ "$#" -le 1 ]] || {
  printf '[remote-deploy] HATA: yalnız bir git ref kabul edilir\n' >&2
  exit 1
}
LOCAL_CONFIG="${PERSISTENT_DEPLOY_CONFIG_FILE:-${ROOT_DIR}/config/local/remote-deploy.sh}"
if [[ -f "${LOCAL_CONFIG}" ]]; then
  # This is trusted, operator-owned shell configuration. The tracked example
  # uses default assignments so explicit process environment values win.
  set -a
  # shellcheck disable=SC1090
  source "${LOCAL_CONFIG}"
  set +a
fi

SSH_BIN="${PERSISTENT_DEPLOY_SSH_BIN:-ssh}"
SSH_TARGET="${PERSISTENT_DEPLOY_SSH_TARGET:-}"
REMOTE_ROOT="${PERSISTENT_DEPLOY_REMOTE_ROOT:-}"
STATE_HOME="${PERSISTENT_DEPLOY_STATE_HOME:-${REMOTE_ROOT:+${REMOTE_ROOT}/state}}"
IDLE_SECONDS="${PERSISTENT_DEPLOY_IDLE_SECONDS:-3600}"
POLL_SECONDS="${PERSISTENT_DEPLOY_POLL_SECONDS:-60}"

log() { printf '[remote-deploy] %s\n' "$*"; }
fail() {
  printf '[remote-deploy] HATA: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-self-hosted-remote.sh [<git-ref>]

Machine-specific values are loaded from:
  config/local/remote-deploy.sh

Copy the tracked template first:
  cp config/local.example/remote-deploy.sh config/local/remote-deploy.sh

Environment overrides:
  PERSISTENT_DEPLOY_CONFIG_FILE=/path/to/remote-deploy.sh
  PERSISTENT_DEPLOY_SSH_BIN=ssh|tailscale
  PERSISTENT_DEPLOY_SSH_TARGET=deploy-host
  PERSISTENT_DEPLOY_REMOTE_ROOT=/srv/perseverance
  PERSISTENT_DEPLOY_STATE_HOME=/srv/perseverance/state
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

command -v "${SSH_BIN}" >/dev/null 2>&1 ||
  fail "SSH komutu bulunamadı: ${SSH_BIN}"
[[ -n "${SSH_TARGET}" ]] ||
  fail "PERSISTENT_DEPLOY_SSH_TARGET gerekli; config/local.example şablonunu kopyalayın"
[[ -n "${REMOTE_ROOT}" ]] ||
  fail "PERSISTENT_DEPLOY_REMOTE_ROOT gerekli; config/local.example şablonunu kopyalayın"
[[ -n "${STATE_HOME}" ]] ||
  fail "PERSISTENT_DEPLOY_STATE_HOME çözümlenemedi"
[[ "${IDLE_SECONDS}" =~ ^[0-9]+$ ]] &&
  ((IDLE_SECONDS >= 60 && IDLE_SECONDS <= 604800)) ||
  fail "PERSISTENT_DEPLOY_IDLE_SECONDS 60..604800 aralığında olmalı"
[[ "${POLL_SECONDS}" =~ ^[0-9]+$ ]] &&
  ((POLL_SECONDS >= 5 && POLL_SECONDS <= 3600)) ||
  fail "PERSISTENT_DEPLOY_POLL_SECONDS 5..3600 aralığında olmalı"
SSH_COMMAND=("${SSH_BIN}")
if [[ "$(basename "${SSH_BIN}")" = "tailscale" ]]; then
  SSH_COMMAND+=(ssh)
fi
[[ "${SSH_TARGET}" =~ ^[A-Za-z0-9_.@-]+$ ]] ||
  fail "güvensiz SSH hedefi: ${SSH_TARGET}"
for remote_path in "${REMOTE_ROOT}" "${STATE_HOME}"; do
  [[ "${remote_path}" =~ ^/[A-Za-z0-9_./-]+$ ]] ||
    fail "güvensiz remote path: ${remote_path}"
done

cd "${ROOT_DIR}"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  fail "local worktree temiz değil; deploy öncesi commit/stash gerekli"
fi

git fetch --quiet --prune origin
TARGET_SHA="$(git rev-parse "${DEPLOY_REF}^{commit}")" ||
  fail "git ref çözümlenemedi: ${DEPLOY_REF}"
[[ "${TARGET_SHA}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "çözümlenen commit geçersiz: ${TARGET_SHA}"
git branch -r --contains "${TARGET_SHA}" | grep -qE '^[[:space:]]*origin/' ||
  fail "${TARGET_SHA} origin'e push edilmemiş"

log "remote deploy kuyruğa alınıyor commit=${TARGET_SHA} idle=${IDLE_SECONDS}s"

"${SSH_COMMAND[@]}" "${SSH_TARGET}" bash -s -- \
  "${TARGET_SHA}" "${REMOTE_ROOT}" "${STATE_HOME}" \
  "${IDLE_SECONDS}" "${POLL_SECONDS}" <<'REMOTE_SCRIPT'
set -euo pipefail

target_sha="$1"
remote_root="$2"
state_home="$3"
idle_seconds="$4"
poll_seconds="$5"
release_root="${remote_root}/releases"
env_file="${state_home}/config/self-hosted.env"
release_state_file="${state_home}/state/current-release.env"
target_release="${release_root}/${target_sha}"
incoming=""

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SELF_HOSTED_HOME="${state_home}"
export GIT_TERMINAL_PROMPT=0

log() { printf '[remote-deploy] %s\n' "$*"; }
fail() {
  printf '[remote-deploy] HATA: %s\n' "$*" >&2
  exit 1
}
read_env() { sed -n "s/^$1=//p" "${env_file}" | tail -n 1; }

command -v docker >/dev/null 2>&1 || fail "remote Docker CLI bulunamadı"
docker info >/dev/null 2>&1 || fail "remote Docker daemon erişilemiyor"
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
[[ -d "${source_release}/.git" ]] ||
  fail "mevcut detached release bulunamadı: ${source_release}"
[[ -z "$(git -C "${source_release}" status --porcelain)" ]] ||
  fail "mevcut release worktree temiz değil: ${source_release}"

validate_release() {
  local release="$1"
  [[ -d "${release}/.git" ]] || return 1
  [[ "$(git -C "${release}" rev-parse HEAD)" = "${target_sha}" ]] || return 1
  [[ -z "$(git -C "${release}" branch --show-current)" ]] || return 1
  [[ -z "$(git -C "${release}" status --porcelain)" ]] || return 1
}

preserve_failed_checkout() {
  if [[ -n "${incoming}" && -d "${incoming}" ]]; then
    failed="${release_root}/.failed-${target_sha}-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "${incoming}" "${failed}"
    log "tamamlanmamış checkout korundu: ${failed}"
  fi
}
trap preserve_failed_checkout EXIT

if [[ -e "${target_release}" ]]; then
  validate_release "${target_release}" ||
    fail "hedef release mevcut ama temiz/detached/exact değil: ${target_release}"
  log "hedef detached release zaten hazır"
else
  incoming="${release_root}/.incoming-${target_sha}-$$"
  [[ ! -e "${incoming}" ]] || fail "incoming release yolu dolu: ${incoming}"
  origin_url="$(git -C "${source_release}" remote get-url origin)"
  log "bağımsız release checkout oluşturuluyor"
  git clone --no-hardlinks --no-checkout "${source_release}" "${incoming}"
  git -C "${incoming}" remote set-url origin "${origin_url}"
  git -C "${incoming}" fetch --prune origin \
    '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'
  git -C "${incoming}" cat-file -e "${target_sha}^{commit}"
  git -C "${incoming}" checkout --detach "${target_sha}"
  validate_release "${incoming}" || fail "oluşturulan release doğrulanamadı"
  mv "${incoming}" "${target_release}"
  incoming=""
fi

deploy_state_dir="${state_home}/state"
mkdir -p "${deploy_state_dir}"
umask 077
pending_file="${deploy_state_dir}/pending-remote-deploy.env"
pending_tmp="${pending_file}.tmp.$$"
{
  printf 'TARGET_SHA=%s\n' "${target_sha}"
  printf 'REQUESTED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'IDLE_SECONDS=%s\n' "${idle_seconds}"
  printf 'POLL_SECONDS=%s\n' "${poll_seconds}"
} >"${pending_tmp}"
mv "${pending_tmp}" "${pending_file}"

worker_script="${target_release}/scripts/run-pending-self-hosted-deploy.sh"
[[ -f "${worker_script}" ]] || fail "remote deploy worker bulunamadı: ${worker_script}"
worker_log="${deploy_state_dir}/remote-deploy-worker.log"
nohup bash "${worker_script}" "${remote_root}" "${state_home}" \
  >>"${worker_log}" 2>&1 </dev/null &

log "pending deploy kaydedildi: ${pending_file}"
log "remote worker başlatıldı; log: ${worker_log}"
REMOTE_SCRIPT
