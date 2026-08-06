#!/usr/bin/env bash
# Same-host delayed deployment worker.
#
# A submitter writes a validated pending commit under SELF_HOSTED_HOME/state and
# starts this process detached from the invoking terminal. The worker waits
# until the installation has been inactive for the configured window and no
# turn is executing, then delegates the actual release to the canonical
# self-hosted lifecycle.

set -euo pipefail

deploy_root="${1:-}"
state_home="${2:-}"

log() { printf '[self-hosted-deploy-worker] %s\n' "$*"; }
fail() {
  printf '[self-hosted-deploy-worker] HATA: %s\n' "$*" >&2
  exit 1
}

command -v realpath >/dev/null 2>&1 || fail "realpath bulunamadı"
canonical_host_path() {
  local raw="$1" resolved
  [[ "${raw}" =~ ^/[A-Za-z0-9_./-]+$ ]] || fail "güvensiz host path: ${raw}"
  [[ ! "${raw}" =~ (^|/)\.\.(/|$) ]] || fail "host path '..' içeremez: ${raw}"
  [[ "${raw}" != */ ]] || fail "host path trailing slash içeremez: ${raw}"
  case "${raw}" in
  /proc | /proc/* | /sys | /sys/*) fail "yasak host path: ${raw}" ;;
  esac
  [[ -e "${raw}" ]] || fail "host path bulunamadı: ${raw}"
  resolved="$(realpath "${raw}")" || fail "host path çözümlenemedi: ${raw}"
  [[ "${resolved}" = "${raw}" ]] ||
    fail "host path symlink veya canonical olmayan bileşen içeriyor: ${raw}"
  printf '%s\n' "${resolved}"
}
deploy_root="$(canonical_host_path "${deploy_root}")"
state_home="$(canonical_host_path "${state_home}")"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SELF_HOSTED_HOME="${state_home}"
export GIT_TERMINAL_PROMPT=0

release_root="${deploy_root}/releases"
env_file="${state_home}/config/self-hosted.env"
release_state_file="${state_home}/state/current-release.env"
deploy_state_dir="${state_home}/state"
# Keep these established names for safe upgrades from the former SSH
# submitter: old and new workers must share one pending target and lock.
pending_file="${deploy_state_dir}/pending-remote-deploy.env"
worker_lock="${deploy_state_dir}/remote-deploy-worker.lock"
worker_pid_file="${deploy_state_dir}/remote-deploy-worker.pid"

mkdir -p "${deploy_state_dir}"
umask 077

lock_acquired=0
for ((attempt = 1; attempt <= 15; attempt++)); do
  if mkdir "${worker_lock}" 2>/dev/null; then
    lock_acquired=1
    break
  fi
  existing_pid="$(sed -n '1p' "${worker_pid_file}" 2>/dev/null || true)"
  if [[ "${existing_pid}" =~ ^[0-9]+$ ]] && kill -0 "${existing_pid}" 2>/dev/null; then
    sleep 2
    continue
  fi
  rmdir "${worker_lock}" 2>/dev/null || true
done
if [[ "${lock_acquired}" -ne 1 ]]; then
  log "başka worker pending deploy'u izliyor"
  exit 0
fi

cleanup() {
  rm -f "${worker_pid_file}"
  rmdir "${worker_lock}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$$" >"${worker_pid_file}"

read_value() {
  local file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "${file}" | tail -n 1
}

require_installation() {
  command -v docker >/dev/null 2>&1 || fail "Docker CLI bulunamadı"
  docker info >/dev/null 2>&1 || fail "Docker daemon erişilemiyor"
  [[ -f "${env_file}" ]] || fail "self-hosted env bulunamadı: ${env_file}"
  [[ -f "${release_state_file}" ]] ||
    fail "tamamlanmış release state bulunamadı: ${release_state_file}"
}

postgres_container() {
  docker ps \
    --filter label=com.docker.compose.project=perseverance-self-hosted \
    --filter label=com.docker.compose.service=postgres \
    --format '{{.ID}}' | sed -n '1p'
}

psql_query() {
  local query="$1"
  local container
  container="$(postgres_container)"
  [[ -n "${container}" ]] || fail "çalışan self-hosted postgres container bulunamadı"
  docker exec "${container}" sh -c '
    export PGPASSWORD="$(cat "${POSTGRES_PASSWORD_FILE}")"
    exec psql -X -A -t -v ON_ERROR_STOP=1 \
      -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "$1"
  ' sh "${query}"
}

latest_activity_epoch() {
  local core_epoch
  core_epoch="$(psql_query "
    SELECT COALESCE(EXTRACT(EPOCH FROM MAX(observed_at))::bigint,0)
    FROM (
      SELECT MAX(occurred_at) AS observed_at
        FROM persistent_codex.ha_events
      UNION ALL
      SELECT MAX(updated_at) AS observed_at
        FROM persistent_codex.ha_runs
    ) observations;
  ")"
  [[ "${core_epoch}" =~ ^[0-9]+$ ]] || fail "geçersiz activity epoch: ${core_epoch}"

  printf '%s\n' "${core_epoch}"
}

active_work_count() {
  local count
  count="$(psql_query "
    SELECT
      (SELECT COUNT(*) FROM persistent_codex.ha_runs
        WHERE state IN ('queued','leased','starting','running'))
      +
      (SELECT COUNT(*) FROM persistent_codex.scheduler_queue
        WHERE state IN ('queued','leased','starting','running'));
  ")"
  [[ "${count}" =~ ^[0-9]+$ ]] || fail "geçersiz active work count: ${count}"
  printf '%s\n' "${count}"
}

validate_release() {
  local release="$1"
  local expected_sha="$2"
  [[ -d "${release}/.git" ]] || return 1
  [[ "$(git -C "${release}" rev-parse HEAD)" = "${expected_sha}" ]] || return 1
  [[ -z "$(git -C "${release}" branch --show-current)" ]] || return 1
  [[ -z "$(git -C "${release}" status --porcelain)" ]] || return 1
}

deploy_release() {
  local target_sha="$1"
  local target_release="${release_root}/${target_sha}"
  local current_sha completed_sha source_release backup_before backup_after
  local deployed_sha container_rows container_count unhealthy public_origin
  local base_path ready_url ready_body ready_ok state_tmp

  require_installation
  validate_release "${target_release}" "${target_sha}" ||
    fail "hedef release temiz/detached/exact değil: ${target_release}"

  current_sha="$(read_value "${env_file}" SELF_HOSTED_SOURCE_COMMIT)"
  [[ "${current_sha}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "mevcut SELF_HOSTED_SOURCE_COMMIT geçersiz"
  completed_sha="$(read_value "${release_state_file}" SELF_HOSTED_SOURCE_COMMIT)"
  [[ "${completed_sha}" =~ ^[0-9a-f]{40}$ ]] ||
    fail "current-release.env commit'i geçersiz"
  [[ "${current_sha}" = "${completed_sha}" ]] ||
    fail "env commit'i (${current_sha}) tamamlanmış release state'iyle (${completed_sha}) eşleşmiyor; önce yarım kalmış deploy'u inceleyin"
  source_release="${release_root}/${current_sha}"
  validate_release "${source_release}" "${current_sha}" ||
    fail "mevcut release temiz/detached/exact değil: ${source_release}"

  if [[ "${current_sha}" = "${target_sha}" ]]; then
    log "hedef commit zaten deploy edilmiş: ${target_sha}"
    return 0
  fi

  backup_before="$(find "${state_home}/backups" -maxdepth 1 -type f \
    -name 'backup-*.tar.enc' -print 2>/dev/null | sort | tail -n 1)"

  cd "${target_release}"
  log "otomatik yedek + upgrade başlatılıyor: ${current_sha} -> ${target_sha}"
  bash infra/self-hosted/self-hosted.sh upgrade

  deployed_sha="$(read_value "${env_file}" SELF_HOSTED_SOURCE_COMMIT)"
  [[ "${deployed_sha}" = "${target_sha}" ]] ||
    fail "upgrade source commit uyuşmuyor: ${deployed_sha}"
  completed_sha="$(read_value "${release_state_file}" SELF_HOSTED_SOURCE_COMMIT)"
  [[ "${completed_sha}" = "${target_sha}" ]] ||
    fail "upgrade tamamlanmış release state'ini güncellemedi: ${completed_sha}"
  validate_release "${target_release}" "${target_sha}" ||
    fail "release upgrade sonrası temiz değil"

  backup_after="$(find "${state_home}/backups" -maxdepth 1 -type f \
    -name 'backup-*.tar.enc' -print 2>/dev/null | sort | tail -n 1)"
  [[ -n "${backup_after}" && "${backup_after}" != "${backup_before}" ]] ||
    fail "upgrade yeni otomatik yedek üretmedi"
  [[ -s "${backup_after}" ]] || fail "otomatik yedek boş: ${backup_after}"

  container_count=0
  unhealthy=""
  for ((attempt = 1; attempt <= 30; attempt++)); do
    container_rows="$(docker ps --filter label=persistent.self-hosted=true \
      --format '{{.Names}}|{{.Image}}|{{.Status}}')"
    container_count="$(printf '%s\n' "${container_rows}" | sed '/^$/d' | wc -l | tr -d ' ')"
    unhealthy="$(printf '%s\n' "${container_rows}" | awk 'index($0,"(healthy)")==0')"
    if [[ "${container_count}" -ge 9 && -z "${unhealthy}" ]]; then break; fi
    sleep 2
  done
  [[ "${container_count}" -ge 9 ]] ||
    fail "beklenen çalışan self-hosted container sayısı yok: ${container_count}"
  [[ -z "${unhealthy}" ]] || fail "healthy olmayan container var: ${unhealthy}"

  public_origin="$(read_value "${env_file}" SELF_HOSTED_PUBLIC_ORIGIN)"
  base_path="$(read_value "${env_file}" SELF_HOSTED_BASE_PATH)"
  ready_url="${public_origin}${base_path}/readyz"
  curl_args=(-fsS --max-time 20)
  [[ "$(read_value "${env_file}" SELF_HOSTED_TLS_MODE)" = acme ]] || curl_args+=(-k)
  ready_ok=0
  for ((attempt = 1; attempt <= 10; attempt++)); do
    if ready_body="$(curl "${curl_args[@]}" "${ready_url}" 2>/dev/null)" &&
      printf '%s' "${ready_body}" |
        grep -Eq '"ready"[[:space:]]*:[[:space:]]*true'; then
      ready_ok=1
      break
    fi
    sleep 2
  done
  [[ "${ready_ok}" -eq 1 ]] ||
    fail "public readiness ready=true dönmedi: ${ready_url}"

  state_tmp="${deploy_state_dir}/last-remote-deploy.env.tmp.$$"
  {
    printf 'SOURCE_COMMIT=%s\n' "${target_sha}"
    printf 'DEPLOYED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'BACKUP_FILE=%s\n' "$(basename "${backup_after}")"
    printf 'READY_URL=%s\n' "${ready_url}"
  } >"${state_tmp}"
  mv "${state_tmp}" "${deploy_state_dir}/last-remote-deploy.env"

  log "container health geçti (${container_count}/${container_count})"
  log "public readiness geçti: ${ready_url}"
  log "deploy tamam: ${target_sha}"
}

require_installation
while [[ -f "${pending_file}" ]]; do
  target_sha="$(read_value "${pending_file}" TARGET_SHA)"
  idle_seconds="$(read_value "${pending_file}" IDLE_SECONDS)"
  poll_seconds="$(read_value "${pending_file}" POLL_SECONDS)"
  [[ "${target_sha}" =~ ^[0-9a-f]{40}$ ]] || fail "pending target SHA geçersiz"
  [[ "${idle_seconds}" =~ ^[0-9]+$ ]] || fail "pending idle süresi geçersiz"
  [[ "${poll_seconds}" =~ ^[0-9]+$ ]] || fail "pending poll süresi geçersiz"
  ((idle_seconds >= 60 && idle_seconds <= 604800)) ||
    fail "pending idle süresi aralık dışında"
  ((poll_seconds >= 5 && poll_seconds <= 3600)) ||
    fail "pending poll süresi aralık dışında"
  validate_release "${release_root}/${target_sha}" "${target_sha}" ||
    fail "pending release temiz/detached/exact değil"

  active_count="$(active_work_count)"
  activity_epoch="$(latest_activity_epoch)"
  now_epoch="$(date -u +%s)"
  activity_age=$((now_epoch - activity_epoch))
  ((activity_age >= 0)) || activity_age=0

  if ((active_count > 0)); then
    log "deploy bekliyor: ${active_count} aktif/queued çalışma var; hedef=${target_sha}"
    sleep "${poll_seconds}"
    continue
  fi
  if ((activity_epoch > 0 && activity_age < idle_seconds)); then
    remaining=$((idle_seconds - activity_age))
    sleep_for="${poll_seconds}"
    ((remaining < sleep_for)) && sleep_for="${remaining}"
    ((sleep_for > 0)) || sleep_for=1
    log "deploy bekliyor: idle pencereye ${remaining}s kaldı; hedef=${target_sha}"
    sleep "${sleep_for}"
    continue
  fi

  # Close the most likely check/use race without introducing a maintenance
  # endpoint: confirm once more after a short quiet settle, immediately before
  # invoking the canonical upgrade.
  sleep 5
  confirmed_active_count="$(active_work_count)"
  confirmed_activity_epoch="$(latest_activity_epoch)"
  confirmed_now_epoch="$(date -u +%s)"
  confirmed_activity_age=$((confirmed_now_epoch - confirmed_activity_epoch))
  ((confirmed_activity_age >= 0)) || confirmed_activity_age=0
  latest_pending_sha="$(read_value "${pending_file}" TARGET_SHA 2>/dev/null || true)"
  if [[ "${latest_pending_sha}" != "${target_sha}" ]] ||
    ((confirmed_active_count > 0)) ||
    ((confirmed_activity_epoch > 0 && confirmed_activity_age < idle_seconds)); then
    log "idle doğrulaması değişti; kapı yeniden değerlendiriliyor"
    continue
  fi

  log "idle kapısı geçti: son aktivite yaşı=${confirmed_activity_age}s; hedef=${target_sha}"
  deploy_release "${target_sha}"

  latest_pending_sha="$(read_value "${pending_file}" TARGET_SHA 2>/dev/null || true)"
  if [[ "${latest_pending_sha}" = "${target_sha}" ]]; then
    rm -f "${pending_file}"
  else
    log "daha yeni pending hedef algılandı; worker izlemeye devam ediyor"
  fi
done

log "pending deploy kalmadı; worker kapanıyor"
