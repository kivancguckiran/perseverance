#!/usr/bin/env bash
#  self-hosted.sh için paylaşılan yardımcılar (ADR-0032).
# Bu dosya tek başına çalıştırılmaz; self-hosted.sh tarafından source edilir.

set -euo pipefail

SELF_HOSTED_PROJECT=perseverance-self-hosted
SELF_HOSTED_LABEL='persistent.self-hosted=true'
SELF_HOSTED_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_HOSTED_REPO_ROOT="$(cd "${SELF_HOSTED_SCRIPT_DIR}/../.." && pwd)"
SELF_HOSTED_HOME="${SELF_HOSTED_HOME:-/var/lib/perseverance}"

log() { printf '[self-hosted] %s\n' "$*"; }
fail() {
  printf '[self-hosted] HATA: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "gerekli komut bulunamadı: $1  $2"
}

config_dir() { printf '%s/config' "${SELF_HOSTED_HOME}"; }
secrets_dir() { printf '%s/secrets' "${SELF_HOSTED_HOME}"; }
backups_dir() { printf '%s/backups' "${SELF_HOSTED_HOME}"; }
state_dir() { printf '%s/state' "${SELF_HOSTED_HOME}"; }
env_file() { printf '%s/self-hosted.env' "$(config_dir)"; }

compose() {
  docker compose \
    --project-name "${SELF_HOSTED_PROJECT}" \
    --env-file "$(env_file)" \
    -f "${SELF_HOSTED_SCRIPT_DIR}/compose.yml" \
    "$@"
}

read_env() {
  # $1: anahtar  env dosyasından değer okur (yalnız KEY=VALUE satırları).
  sed -n "s/^$1=//p" "$(env_file)" | tail -n 1
}

gen_secret() { openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_'; }

# --- base-path (subpath) yardımcıları (ADR-0038) ------------------------

normalize_base_path() {
  # $1: ham değer  normalize edilmiş base path'i basar (boş = kök).
  # Kurallar: başta '/', sonda '/' yok, segmentler [A-Za-z0-9._~-], '.'/'..'
  # yasak, uygulama-rezerve kökleriyle çakışma yasak. Geçersizse 1 döner.
  local raw="${1:-}"
  raw="${raw%/}"
  if [ -z "${raw}" ]; then
    printf ''
    return 0
  fi
  case "${raw}" in
  //* | */) return 1 ;;
  /*) : ;;
  *) return 1 ;;
  esac
  local segment
  local IFS='/'
  for segment in ${raw#/}; do
    [ -n "${segment}" ] || return 1
    case "${segment}" in
    . | ..) return 1 ;;
    *[!A-Za-z0-9._~-]*) return 1 ;;
    esac
  done
  case "${raw}" in
  /v1 | /v1/* | /healthz | /readyz | /assets | /assets/* | /events | /events/*) return 1 ;;
  esac
  printf '%s' "${raw}"
}

effective_base_path() {
  # Bayrak/env verilmişse onu, yoksa kurulu env dosyasındaki değeri normalize
  # eder; geçersiz değerde 1 döner (çağıran fail-closed davranır).
  local raw=""
  if [ -n "${SELF_HOSTED_BASE_PATH+x}" ]; then
    raw="${SELF_HOSTED_BASE_PATH}"
  elif [ -f "$(env_file)" ]; then
    raw="$(read_env SELF_HOSTED_BASE_PATH)"
  fi
  normalize_base_path "${raw}"
}

normalize_domain() {
  # $1: şemasız DNS adı. Port, path, wildcard ve boş etiket reddedilir.
  local raw="${1:-}" normalized label
  [ -n "${raw}" ] && [ "${#raw}" -le 253 ] || return 1
  case "${raw}" in
  .* | *. | *..* | *[!A-Za-z0-9.-]*) return 1 ;;
  esac
  local IFS='.'
  for label in ${raw}; do
    [ -n "${label}" ] && [ "${#label}" -le 63 ] || return 1
    case "${label}" in
    -* | *- | *[!A-Za-z0-9-]*) return 1 ;;
    esac
  done
  normalized="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]')"
  printf '%s' "${normalized}"
}

pwa_id_for_base() {
  # Manifest identity root-relative ve origin'e bağlıdır. Base path değişse de
  # bu ilk değer kurulum state'inde korunur.
  local base="${1:-}"
  if [ -n "${base}" ]; then
    printf '%s/' "${base}"
  else
    printf '/'
  fi
}

normalize_pwa_id() {
  local value="${1:-}"
  case "${value}" in
  /) : ;;
  /*/)
    normalize_base_path "${value%/}" >/dev/null || return 1
    ;;
  *) return 1 ;;
  esac
  printf '%s' "${value}"
}

effective_pwa_id() {
  # $1: yeni kurulumda fallback olacak normalize base path. Mevcut kurulumda
  # kayıtlı identity, açık env/flag override yoksa korunur.
  local fallback_base="${1:-}" value=""
  if [ -n "${SELF_HOSTED_PWA_ID+x}" ]; then
    value="${SELF_HOSTED_PWA_ID}"
  elif [ -f "$(env_file)" ]; then
    installed_pwa_id || return 1
    return 0
  else
    value="$(pwa_id_for_base "${fallback_base}")"
  fi
  normalize_pwa_id "${value}"
}

installed_pwa_id() {
  # Kurulu state'i yalnız dosyadan okur; reconfigure sırasında hedef override
  # verilse bile rollback için mevcut identity doğru yakalanır.
  local installed_base="" value=""
  [ -f "$(env_file)" ] || return 1
  value="$(read_env SELF_HOSTED_PWA_ID)"
  if [ -z "${value}" ]; then
    installed_base="$(normalize_base_path "$(read_env SELF_HOSTED_BASE_PATH)")" ||
      return 1
    value="$(pwa_id_for_base "${installed_base}")"
  fi
  normalize_pwa_id "${value}"
}

product_image_tag() {
  # $1: source commit, $2: normalize base path  kökte tag değişmez; base'li
  # kurulumda base slug'ı eklenir ki base değişikliği yeni build tetiklesin.
  local commit="$1" base="${2:-}"
  if [ -n "${base}" ]; then
    printf 'perseverance-self-hosted-product:%s-%s' "${commit}" \
      "$(printf '%s' "${base#/}" | tr '/' '-')"
  else
    printf 'perseverance-self-hosted-product:%s' "${commit}"
  fi
}

ensure_dirs() {
  umask 077
  mkdir -p "$(config_dir)/tls" "$(secrets_dir)" "$(backups_dir)" "$(state_dir)"
  chmod 700 "${SELF_HOSTED_HOME}" "$(config_dir)" "$(secrets_dir)" \
    "$(backups_dir)" "$(state_dir)"
}

ensure_secret_file() {
  # $1: dosya adı  yoksa openssl rand ile üretir, 0600 tutar.
  local path
  path="$(secrets_dir)/$1"
  if [ ! -f "${path}" ]; then
    gen_secret >"${path}"
    chmod 600 "${path}"
  fi
}

verify_pinned_image() {
  # $1: tag@sha256 pinli imaj referansı  pull sonrası RepoDigests doğrulaması.
  local reference="$1" repository digest repo_digests
  repository="${reference%%@*}"
  repository="${repository%%:*}"
  digest="${reference##*@}"
  case "${digest}" in
  sha256:*) : ;;
  *) fail "imaj digest pinli değil: ${reference}" ;;
  esac
  repo_digests="$(docker image inspect --format '{{join .RepoDigests "\n"}}' "${reference}" 2>/dev/null)" ||
    fail "imaj bulunamadı (pull başarısız?): ${reference}"
  printf '%s\n' "${repo_digests}" | grep -q "${repository}@${digest}" ||
    fail "imaj digest uyuşmazlığı: ${reference}  RepoDigests: ${repo_digests}"
}

pinned_images() {
  # Runtime'ın ihtiyaç duyduğu üçüncü parti imajları listeler. Release builder
  # yalnız artifact üreten hostta gerekir; kurulum hostuna çekilmez.
  sed -n '/^SELF_HOSTED_RELEASE_/d; s/^SELF_HOSTED_[A-Z_]*_IMAGE=//p' \
    "${SELF_HOSTED_SCRIPT_DIR}/images.env" |
    grep '@sha256:'
}

labeled_resources() {
  {
    docker ps -aq --filter "label=${SELF_HOSTED_LABEL}"
    docker volume ls -q --filter "label=${SELF_HOSTED_LABEL}"
    docker network ls -q --filter "label=${SELF_HOSTED_LABEL}"
  } | sed '/^$/d'
}

wait_public_ready() {
  # $1: public origin, $2: deneme sayısı  /readyz 'ready' dönene dek bekler.
  # base-path'li kurulumda readiness base altından doğrulanır (kök
  # /readyz ayrıca korunur; eski env dosyalarında anahtar yoksa base boştur).
  local origin="$1" attempts="${2:-60}" insecure=() base=""
  base="$(read_env SELF_HOSTED_BASE_PATH)"
  [ "$(read_env SELF_HOSTED_TLS_MODE)" != "acme" ] && insecure=(-k)
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS --max-time 5 "${insecure[@]}" "${origin}${base}/readyz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

release_state_file() { printf '%s/current-release.env' "$(state_dir)"; }
previous_release_file() { printf '%s/previous-release.env' "$(state_dir)"; }

write_release_state() {
  # $1: source commit, $2: product imaj referansı. Public URL/PWA koordinatları
  # aynı state kaydında tutulur ki rollback eski imajı yanlış base ile açmasın.
  if [ -f "$(release_state_file)" ]; then
    cp "$(release_state_file)" "$(previous_release_file)"
  fi
  write_current_release_state "$1" "$2"
}

write_current_release_state() {
  # Önceki release'i döndürmeden current-release.env kaydını tazeler. Eski iki
  # alanlı state dosyalarını reconfigure öncesi atomik rollback bilgisiyle
  # zenginleştirmek için kullanılır.
  {
    printf 'SELF_HOSTED_SOURCE_COMMIT=%s\n' "$1"
    printf 'SELF_HOSTED_PRODUCT_IMAGE=%s\n' "${2:-perseverance-self-hosted-product:$1}"
    printf 'SELF_HOSTED_DOMAIN=%s\n' "$(read_env SELF_HOSTED_DOMAIN)"
    printf 'SELF_HOSTED_PUBLIC_ORIGIN=%s\n' "$(read_env SELF_HOSTED_PUBLIC_ORIGIN)"
    printf 'SELF_HOSTED_BASE_PATH=%s\n' "$(read_env SELF_HOSTED_BASE_PATH)"
    printf 'SELF_HOSTED_PWA_ID=%s\n' "$(installed_pwa_id)"
  } >"$(release_state_file)"
  chmod 600 "$(release_state_file)"
}

update_env_value() {
  # $1: anahtar, $2: değer  env dosyasında anahtarı günceller veya ekler.
  local key="$1" value="$2" file
  file="$(env_file)"
  if grep -q "^${key}=" "${file}"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "${file}" && rm -f "${file}.bak"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${file}"
  fi
  chmod 600 "${file}"
}
