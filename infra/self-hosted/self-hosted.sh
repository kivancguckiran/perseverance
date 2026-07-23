#!/usr/bin/env bash
# WP32 — Persistent Codex Workspace self-hosted dağıtım CLI'ı (ADR-0032).
#
# Tek komut kurulum:
#   bash infra/self-hosted/self-hosted.sh install \
#     --domain workspace.example.com --acme-email admin@example.com
#
# Komutlar: preflight | install | status | admin-token | codex-login | backup |
#           restore | upgrade | rollback | uninstall | verify-release
# Tüm komutlar non-interactive'dir ve her eksikte actionable hata ile fail-closed
# davranır. Ayrıntılar: docs/operations/self-hosted-install-runbook.md

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

PREFLIGHT_FAILURES=()
run_check() {
  # $1: ad, $2: actionable öneri, $3…: kontrol komutu
  local name="$1" hint="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then
    log "PASS ${name}"
  else
    log "FAIL ${name} — ${hint}"
    PREFLIGHT_FAILURES+=("${name}")
  fi
}

check_arch() {
  case "$(uname -m)" in x86_64 | aarch64 | arm64) return 0 ;; *) return 1 ;; esac
}
check_memory() {
  local mem_kb
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  [ "${mem_kb}" -ge $((3 * 1024 * 1024)) ]
}
check_disk() {
  local target="${SELF_HOSTED_HOME}"
  [ -d "${target}" ] || target="$(dirname "${SELF_HOSTED_HOME}")"
  [ -d "${target}" ] || target=/
  local disk_kb
  disk_kb="$(df -Pk "${target}" | awk 'NR==2 {print $4}')"
  [ "${disk_kb}" -ge $((20 * 1024 * 1024)) ]
}
check_tls_mode() {
  case "${SELF_HOSTED_TLS_MODE:-acme}" in acme | internal | custom) return 0 ;; *) return 1 ;; esac
}
check_ports_free() {
  command -v ss >/dev/null 2>&1 || return 0
  [ -z "$(ss -Hltn 'sport = :80' 2>/dev/null)" ] &&
    [ -z "$(ss -Hltn 'sport = :443' 2>/dev/null)" ]
}
check_registry() {
  docker image inspect "$(pinned_images | head -n 1)" >/dev/null 2>&1 ||
    getent hosts registry-1.docker.io >/dev/null 2>&1
}
check_env_file_mode() {
  [ "$(stat -c %a "$(env_file)" 2>/dev/null || echo 600)" = 600 ]
}
check_provider_auth() {
  [ "${SELF_HOSTED_PROVIDER_AUTH:-required}" = defer ] && return 0
  compose exec -T workspace-agent sh -c 'test -f /codex-home/auth.json' >/dev/null 2>&1
}

cmd_preflight() {
  local phase="${1:-full}"
  PREFLIGHT_FAILURES=()

  run_check os-linux \
    "self-hosted dağıtım Linux hedefler (uname -s: $(uname -s))" \
    test "$(uname -s)" = Linux
  run_check arch-supported \
    "desteklenen mimariler: x86_64, aarch64 (mevcut: $(uname -m))" \
    check_arch
  run_check docker-cli \
    "docker kurulu değil: https://docs.docker.com/engine/install/" \
    command -v docker
  run_check docker-daemon \
    "docker daemon erişilemiyor; servis çalışıyor mu, kullanıcı docker grubunda mı?" \
    docker info
  run_check docker-compose-v2 \
    "docker compose v2 eklentisi gerekli" \
    docker compose version
  run_check openssl \
    "openssl gerekli (secret üretimi ve yedek şifreleme)" \
    command -v openssl
  run_check curl \
    "curl gerekli (health doğrulaması)" \
    command -v curl
  run_check cpu-min-2 \
    "en az 2 vCPU gerekir (mevcut: $(nproc 2>/dev/null || echo '?'))" \
    test "$(nproc 2>/dev/null || echo 0)" -ge 2
  run_check memory-min-4g \
    "en az 4 GiB bellek gerekir" \
    check_memory
  run_check disk-min-20g \
    "${SELF_HOSTED_HOME} için en az 20 GiB boş alan gerekir" \
    check_disk
  run_check domain-set \
    "--domain veya SELF_HOSTED_DOMAIN zorunlu (kanonik alan adı)" \
    test -n "${SELF_HOSTED_DOMAIN:-}"
  run_check tls-mode-valid \
    "SELF_HOSTED_TLS_MODE acme|internal|custom olmalı" \
    check_tls_mode

  if [ "${SELF_HOSTED_TLS_MODE:-acme}" = acme ]; then
    run_check acme-email-set \
      "acme modunda --acme-email zorunlu" \
      test -n "${SELF_HOSTED_ACME_EMAIL:-}"
    if [ "${SELF_HOSTED_SKIP_DNS_CHECK:-0}" != 1 ]; then
      run_check dns-resolves \
        "${SELF_HOSTED_DOMAIN:-<domain>} çözümlenemiyor; DNS A/AAAA kaydını bu hosta yönlendirin (bilinçli atlama: SELF_HOSTED_SKIP_DNS_CHECK=1)" \
        getent hosts "${SELF_HOSTED_DOMAIN:-invalid.invalid}"
    fi
  fi

  if [ "${SELF_HOSTED_TLS_MODE:-acme}" = custom ]; then
    run_check custom-tls-cert \
      "custom modda $(config_dir)/tls/cert.pem gerekli" \
      test -f "$(config_dir)/tls/cert.pem"
    run_check custom-tls-key \
      "custom modda $(config_dir)/tls/key.pem gerekli" \
      test -f "$(config_dir)/tls/key.pem"
  fi

  if [ ! -f "$(env_file)" ]; then
    run_check ports-80-443-free \
      "80/443 portları başka bir süreç tarafından kullanılıyor" \
      check_ports_free
  fi
  run_check registry-reachable \
    "registry-1.docker.io erişilemiyor ve pinli imajlar lokalde yok; hava-boşluklu kurulum için imajları önceden 'docker load' ile yükleyin" \
    check_registry

  if [ "${phase}" = full ] && [ -f "$(env_file)" ]; then
    run_check env-file-0600 \
      "$(env_file) 0600 izinli olmalı (chmod 600)" \
      check_env_file_mode
    if compose ps --format json >/dev/null 2>&1; then
      run_check provider-auth-ready \
        "codex credential'ı yok: 'self-hosted.sh codex-login' çalıştırın (bilinçli erteleme: --provider-auth=defer)" \
        check_provider_auth
    fi
  fi

  if [ "${#PREFLIGHT_FAILURES[@]}" -gt 0 ]; then
    fail "preflight fail-closed: ${PREFLIGHT_FAILURES[*]}"
  fi
  log "preflight geçti"
}

# ---------------------------------------------------------------------------
# release doğrulaması (wp29 imza/provenance hattı)
# ---------------------------------------------------------------------------

cmd_verify_release() {
  local bundle="${1:-${SELF_HOSTED_RELEASE_BUNDLE:-}}"
  [ -n "${bundle}" ] || fail "verify-release <bundle-dizini> gerekli"
  [ -d "${bundle}" ] || fail "bundle dizini yok: ${bundle}"
  bundle="$(cd "${bundle}" && pwd)"
  local cosign_image node_image
  cosign_image="$(sed -n 's/^SELF_HOSTED_COSIGN_IMAGE=//p' "${SELF_HOSTED_SCRIPT_DIR}/images.env")"
  node_image="$(sed -n 's/^SELF_HOSTED_NODE_IMAGE=//p' "${SELF_HOSTED_SCRIPT_DIR}/images.env")"

  for required_file in SHA256SUMS release-manifest.json trust-policy.json \
    provenance.intoto.json cosign.pub; do
    [ -f "${bundle}/${required_file}" ] ||
      fail "bundle eksik: ${required_file} (imzalı release bundle'ı wp29 hattıyla üretilmelidir)"
  done

  log "checksum doğrulanıyor (SHA256SUMS)"
  (cd "${bundle}" && sha256sum -c SHA256SUMS --quiet) ||
    fail "SHA256SUMS doğrulaması başarısız — bundle bütünlüğü bozuk"

  log "cosign imzaları doğrulanıyor"
  local signed
  for signed in "${bundle}"/*.sig; do
    [ -e "${signed}" ] || fail "bundle'da .sig imzası yok"
    local target="${signed%.sig}"
    docker run --rm -v "${bundle}:/work:ro" "${cosign_image}" \
      verify-blob --insecure-ignore-tlog \
      --key /work/cosign.pub \
      --signature "/work/$(basename "${signed}")" \
      "/work/$(basename "${target}")" >/dev/null 2>&1 ||
      fail "cosign imza doğrulaması başarısız: $(basename "${target}")"
  done

  log "trust policy ve provenance doğrulanıyor"
  docker run --rm -v "${bundle}:/work:ro" "${node_image}" node -e '
    const { readFileSync } = require("node:fs")
    const { createHash } = require("node:crypto")
    const policy = JSON.parse(readFileSync("/work/trust-policy.json", "utf8"))
    const manifest = JSON.parse(readFileSync("/work/release-manifest.json", "utf8"))
    const provenance = JSON.parse(readFileSync("/work/provenance.intoto.json", "utf8"))
    const assert = (ok, message) => { if (!ok) { console.error("FAIL: " + message); process.exit(1) } }
    assert(policy.revoked === false, "trust policy revoked")
    assert(Date.parse(policy.validUntil) > Date.now(), "trust policy süresi dolmuş")
    assert(policy.repository === "persistent-codex-workspace", "repository uyuşmazlığı")
    assert(policy.sourceCommit === manifest.sourceCommit, "sourceCommit uyuşmazlığı")
    assert(provenance.predicateType === "https://slsa.dev/provenance/v1", "provenance predicateType")
    const sums = Object.fromEntries(
      readFileSync("/work/SHA256SUMS", "utf8").trim().split("\n")
        .map((line) => line.split(/\s+\*?/)).map(([digest, name]) => [name, digest]),
    )
    for (const subject of provenance.subject ?? [])
      assert(sums[subject.name] === subject.digest?.sha256,
        "provenance subject uyuşmazlığı: " + subject.name)
    console.log("trust-policy + provenance OK — sourceCommit " + manifest.sourceCommit)
  ' || fail "trust policy / provenance doğrulaması başarısız"

  log "release doğrulaması geçti: ${bundle}"
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------

generate_identity_keys() {
  local node_image="$1"
  if [ -f "$(secrets_dir)/oidc-private.pem" ]; then return 0; fi
  log "identity RSA anahtarı üretiliyor"
  docker run --rm -u 0 -v "$(secrets_dir):/sec" "${node_image}" node -e '
    const { generateKeyPairSync } = require("node:crypto")
    const { writeFileSync, chmodSync, chownSync } = require("node:fs")
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    writeFileSync("/sec/oidc-private.pem", privateKey.export({ type: "pkcs8", format: "pem" }))
    const jwk = publicKey.export({ format: "jwk" })
    writeFileSync("/sec/oidc-public.jwk",
      JSON.stringify({ ...jwk, kid: "self-hosted", alg: "RS256", use: "sig" }))
    for (const file of ["/sec/oidc-private.pem", "/sec/oidc-public.jwk"]) {
      chmodSync(file, 0o600)
      chownSync(file, 10001, 10001)
    }
  '
}

render_caddyfile() {
  local domain="$1" mode="$2" email="${3:-}"
  local tls_directive="" email_block=""
  case "${mode}" in
  acme) email_block="email ${email}" ;;
  internal) tls_directive="tls internal" ;;
  custom) tls_directive="tls /etc/self-hosted-tls/cert.pem /etc/self-hosted-tls/key.pem" ;;
  esac
  sed \
    -e "s|@@DOMAIN@@|${domain}|g" \
    -e "s|@@TLS_DIRECTIVE@@|${tls_directive}|" \
    -e "s|@@ACME_EMAIL_BLOCK@@|${email_block}|" \
    "${SELF_HOSTED_SCRIPT_DIR}/config/Caddyfile.tmpl" >"$(config_dir)/Caddyfile"
  chmod 600 "$(config_dir)/Caddyfile"
}

render_env_file() {
  local domain="$1" source_commit="$2"
  umask 077
  {
    echo "# WP32 self-hosted yapılandırması — self-hosted.sh install tarafından üretildi."
    echo "# Bu dosya secret içerir; 0600 izinli tutulur ve yedeklere dahil edilmez."
    cat "${SELF_HOSTED_SCRIPT_DIR}/images.env" | grep -v '^#'
    echo "SELF_HOSTED_DOMAIN=${domain}"
    echo "SELF_HOSTED_PUBLIC_ORIGIN=https://${domain}"
    echo "SELF_HOSTED_TLS_MODE=${SELF_HOSTED_TLS_MODE:-acme}"
    echo "SELF_HOSTED_HTTP_BIND=${SELF_HOSTED_HTTP_BIND:-0.0.0.0}"
    echo "SELF_HOSTED_HTTPS_BIND=${SELF_HOSTED_HTTPS_BIND:-0.0.0.0}"
    echo "SELF_HOSTED_SOURCE_COMMIT=${source_commit}"
    echo "SELF_HOSTED_PRODUCT_IMAGE=persistent-self-hosted-product:${source_commit}"
    echo "SELF_HOSTED_OIDC_ISSUER=${SELF_HOSTED_OIDC_ISSUER:-http://identity:3303}"
    echo "SELF_HOSTED_OIDC_AUDIENCE=${SELF_HOSTED_OIDC_AUDIENCE:-persistent-codex-self-hosted}"
    echo "SELF_HOSTED_ADMIN_SUBJECT=${SELF_HOSTED_ADMIN_SUBJECT:-self-hosted-admin}"
    echo "SELF_HOSTED_ORGANIZATION_NAME=${SELF_HOSTED_ORGANIZATION_NAME:-Self-hosted organization}"
    echo "SELF_HOSTED_ORGANIZATION_ID=org_$(openssl rand -hex 8)"
    echo "SELF_HOSTED_WORKSPACE_ID=wsp_$(openssl rand -hex 8)"
    echo "SELF_HOSTED_REGION_ID=${SELF_HOSTED_REGION_ID:-self-hosted-1}"
    echo "SELF_HOSTED_NODE_ID=${SELF_HOSTED_NODE_ID:-self-hosted-node-1}"
    echo "SELF_HOSTED_INSTANCE_ID=${SELF_HOSTED_INSTANCE_ID:-self-hosted-control-plane}"
    echo "SELF_HOSTED_OBJECT_BUCKET=${SELF_HOSTED_OBJECT_BUCKET:-self-hosted}"
    echo "SELF_HOSTED_NODE_CPU_MILLIS=$(($(nproc) * 1000))"
    echo "SELF_HOSTED_NODE_MEMORY_BYTES=$(awk '/MemTotal/ {print $2 * 1024}' /proc/meminfo)"
    echo "SELF_HOSTED_POSTGRES_RUNTIME_PASSWORD=$(cat "$(secrets_dir)/postgres-runtime-password")"
    echo "SELF_HOSTED_BROKER_PASSWORD=$(cat "$(secrets_dir)/broker-password")"
    echo "SELF_HOSTED_MINIO_ROOT_USER=self-hosted-operator"
    echo "SELF_HOSTED_MINIO_ROOT_PASSWORD=$(cat "$(secrets_dir)/minio-root-password")"
    echo "SELF_HOSTED_TELEMETRY_SCOPE_SALT=$(cat "$(secrets_dir)/telemetry-scope-salt")"
    echo "SELF_HOSTED_SECRETS_DIR=$(secrets_dir)"
    echo "SELF_HOSTED_CONFIG_DIR=$(config_dir)"
    echo "SELF_HOSTED_BACKUP_DIR=$(backups_dir)"
    echo "SELF_HOSTED_DIST_DIR=${SELF_HOSTED_SCRIPT_DIR}"
    echo "SELF_HOSTED_MIGRATIONS_DIR=${SELF_HOSTED_REPO_ROOT}/infra/postgres/migrations"
  } >"$(env_file)"
  chmod 600 "$(env_file)"
}

cmd_install() {
  ensure_dirs
  cmd_preflight pre-install

  if [ -n "${SELF_HOSTED_RELEASE_BUNDLE:-}" ]; then
    cmd_verify_release "${SELF_HOSTED_RELEASE_BUNDLE}"
  else
    log "release bundle verilmedi; kaynaktan kurulum (git worktree) doğrulanıyor"
    git -C "${SELF_HOSTED_REPO_ROOT}" rev-parse HEAD >/dev/null 2>&1 ||
      fail "kaynak kurulumda repo checkout'u gerekli (veya SELF_HOSTED_RELEASE_BUNDLE verin)"
  fi
  local source_commit
  source_commit="$(git -C "${SELF_HOSTED_REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo bundle)"

  log "secret'lar üretiliyor"
  ensure_secret_file postgres-password
  ensure_secret_file postgres-runtime-password
  ensure_secret_file broker-password
  ensure_secret_file minio-root-password
  ensure_secret_file telemetry-scope-salt
  ensure_secret_file backup-key

  local node_image
  node_image="$(sed -n 's/^SELF_HOSTED_NODE_IMAGE=//p' "${SELF_HOSTED_SCRIPT_DIR}/images.env")"

  log "pinli imajlar çekiliyor ve digest doğrulanıyor"
  local image
  while IFS= read -r image; do
    docker image inspect "${image}" >/dev/null 2>&1 || docker pull "${image}" >/dev/null
    verify_pinned_image "${image}"
  done < <(pinned_images)

  generate_identity_keys "${node_image}"

  if [ ! -f "$(env_file)" ]; then
    log "yapılandırma üretiliyor: $(env_file)"
    render_env_file "${SELF_HOSTED_DOMAIN}" "${source_commit}"
  else
    log "mevcut yapılandırma korunuyor: $(env_file)"
    update_env_value SELF_HOSTED_SOURCE_COMMIT "${source_commit}"
    update_env_value SELF_HOSTED_PRODUCT_IMAGE "persistent-self-hosted-product:${source_commit}"
  fi
  render_caddyfile "$(read_env SELF_HOSTED_DOMAIN)" "$(read_env SELF_HOSTED_TLS_MODE)" \
    "${SELF_HOSTED_ACME_EMAIL:-}"

  log "product imajı build ediliyor (persistent-self-hosted-product:${source_commit})"
  if ! docker image inspect "persistent-self-hosted-product:${source_commit}" >/dev/null 2>&1; then
    docker build \
      -f "${SELF_HOSTED_SCRIPT_DIR}/product.Dockerfile" \
      -t "persistent-self-hosted-product:${source_commit}" \
      "${SELF_HOSTED_REPO_ROOT}"
  fi

  log "altyapı servisleri başlatılıyor"
  compose up -d --wait --wait-timeout 600 postgres object-storage broker identity

  log "migration'lar uygulanıyor"
  compose run --rm migrate

  log "ilk kurulum bootstrap'i çalıştırılıyor"
  compose run --rm bootstrap

  log "uygulama servisleri başlatılıyor"
  compose up -d --wait --wait-timeout 600 workspace-agent control-plane web proxy

  local origin
  origin="$(read_env SELF_HOSTED_PUBLIC_ORIGIN)"
  log "public origin üzerinden readiness doğrulanıyor: ${origin}/readyz"
  wait_public_ready "${origin}" 60 ||
    fail "public readiness doğrulanamadı: ${origin}/readyz — 'self-hosted.sh status' ve proxy loglarına bakın"

  write_release_state "${source_commit}"

  log "kurulum tamam: ${origin}"
  log "sonraki adımlar:"
  log "  1) self-hosted.sh codex-login   # provider credential'ı (yalnız codex-home volume'unda kalır)"
  log "  2) self-hosted.sh admin-token   # PWA oturumu için kısa ömürlü admin token"
  log "  3) self-hosted.sh preflight     # provider auth dahil tam doğrulama"
  if [ "${SELF_HOSTED_PROVIDER_AUTH:-required}" != defer ]; then
    compose exec -T workspace-agent sh -c 'test -f /codex-home/auth.json' >/dev/null 2>&1 ||
      fail "provider auth henüz hazır değil (fail-closed): 'self-hosted.sh codex-login' çalıştırın veya --provider-auth=defer ile bilinçli erteleyin"
  fi
}

# ---------------------------------------------------------------------------
# status / admin-token / codex-login
# ---------------------------------------------------------------------------

cmd_status() {
  compose ps
  local origin
  origin="$(read_env SELF_HOSTED_PUBLIC_ORIGIN)"
  if wait_public_ready "${origin}" 1; then
    log "public readiness: OK (${origin}/readyz)"
  else
    log "public readiness: BAŞARISIZ (${origin}/readyz)"
  fi
  if compose exec -T workspace-agent sh -c 'test -f /codex-home/auth.json' >/dev/null 2>&1; then
    log "provider auth: hazır (codex-home volume)"
  else
    log "provider auth: eksik — self-hosted.sh codex-login"
  fi
}

cmd_admin_token() {
  local subject ttl="${2:-14400}"
  subject="${1:-$(read_env SELF_HOSTED_ADMIN_SUBJECT)}"
  compose exec -T identity node /opt/self-hosted/identity-service.mjs mint "${subject}" "${ttl}"
}

cmd_codex_login() {
  log "codex login workspace-agent container'ında başlatılıyor (credential /codex-home volume'unda kalır)"
  compose exec workspace-agent sh -c 'CODEX_HOME=/codex-home node /app/codex/bin/codex.js login "$@"' -- "$@"
  compose exec -T workspace-agent sh -c 'test -f /codex-home/auth.json' ||
    fail "login tamamlanmadı: /codex-home/auth.json oluşmadı"
  log "provider auth hazır"
}

# ---------------------------------------------------------------------------
# backup / restore
# ---------------------------------------------------------------------------

cmd_backup() {
  local include_credentials=0 output
  output="$(backups_dir)"
  while [ $# -gt 0 ]; do
    case "$1" in
    --include-provider-credentials) include_credentials=1 ;;
    --output) output="$2" && shift ;;
    *) fail "bilinmeyen backup argümanı: $1" ;;
    esac
    shift
  done
  mkdir -p "${output}"
  local backup_id workdir
  backup_id="backup-$(date -u +%Y%m%dT%H%M%SZ)"
  workdir="$(backups_dir)/tmp-$$"
  mkdir -p "${workdir}" && chmod 700 "${workdir}"
  trap 'rm -rf "${workdir}"' RETURN

  log "postgres dump alınıyor (pg_dump -Fc)"
  compose exec -T postgres sh -c \
    'pg_dump -U self_hosted_admin -Fc persistent_codex' >"${workdir}/database.dump"

  log "object storage ve workspace verisi arşivleniyor"
  compose run --rm ops-shell \
    "mkdir -p /backup/tmp-$$ && tar -C /mnt/object-data -cf /backup/tmp-$$/object-data.tar . && tar -C /mnt/workspace-data -cf /backup/tmp-$$/workspace-data.tar ."
  if [ "${include_credentials}" = 1 ]; then
    log "provider credential'ları dahil ediliyor (arşiv her durumda şifrelidir)"
    compose run --rm ops-shell \
      "tar -C /mnt/codex-home -cf /backup/tmp-$$/codex-home.tar ."
  fi

  local source_commit
  source_commit="$(read_env SELF_HOSTED_SOURCE_COMMIT)"
  {
    echo "{"
    echo "  \"backupId\": \"${backup_id}\","
    echo "  \"sourceCommit\": \"${source_commit}\","
    echo "  \"includesProviderCredentials\": ${include_credentials},"
    echo "  \"members\": ["
    local first=1 member
    for member in "${workdir}"/*; do
      [ "${first}" = 1 ] || echo ","
      first=0
      printf '    {"name": "%s", "sha256": "%s"}' \
        "$(basename "${member}")" "$(sha256sum "${member}" | cut -d' ' -f1)"
    done
    echo ""
    echo "  ]"
    echo "}"
  } >"${workdir}/manifest.json"

  log "arşiv şifreleniyor (${backup_id}.tar.enc)"
  tar -C "${workdir}" -cf "${workdir}.tar" .
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass "file:$(secrets_dir)/backup-key" \
    -in "${workdir}.tar" -out "${output}/${backup_id}.tar.enc"
  rm -f "${workdir}.tar"
  sha256sum "${output}/${backup_id}.tar.enc" | cut -d' ' -f1 \
    >"${output}/${backup_id}.sha256"
  chmod 600 "${output}/${backup_id}.tar.enc" "${output}/${backup_id}.sha256"
  log "yedek hazır: ${output}/${backup_id}.tar.enc"
  log "NOT: $(secrets_dir)/backup-key olmadan bu yedek AÇILAMAZ; anahtarı güvenli bir yerde saklayın."
  printf '%s\n' "${output}/${backup_id}.tar.enc"
}

cmd_restore() {
  local archive="${1:-}"
  [ -n "${archive}" ] || fail "restore <yedek.tar.enc> gerekli"
  [ -f "${archive}" ] || fail "yedek dosyası yok: ${archive}"
  local checksum_file="${archive%.tar.enc}.sha256"
  if [ -f "${checksum_file}" ]; then
    [ "$(sha256sum "${archive}" | cut -d' ' -f1)" = "$(cat "${checksum_file}")" ] ||
      fail "yedek sha256 doğrulaması başarısız — dosya bozuk"
  fi

  local workdir
  workdir="$(backups_dir)/restore-$$"
  mkdir -p "${workdir}" && chmod 700 "${workdir}"
  trap 'rm -rf "${workdir}"' RETURN

  log "arşiv çözülüyor"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
    -pass "file:$(secrets_dir)/backup-key" \
    -in "${archive}" -out "${workdir}/combined.tar" ||
    fail "şifre çözme başarısız — backup-key doğru mu?"
  tar -C "${workdir}" -xf "${workdir}/combined.tar" && rm -f "${workdir}/combined.tar"
  [ -f "${workdir}/database.dump" ] || fail "arşivde database.dump yok"

  log "uygulama servisleri durduruluyor"
  compose stop proxy web control-plane workspace-agent

  log "postgres geri yükleniyor (pg_restore --clean)"
  compose exec -T postgres sh -c \
    'pg_restore -U self_hosted_admin -d persistent_codex --clean --if-exists' \
    <"${workdir}/database.dump"

  log "object storage ve workspace verisi geri yükleniyor"
  local restore_rel="restore-$$"
  compose run --rm ops-shell \
    "find /mnt/object-data -mindepth 1 -delete && tar -C /mnt/object-data -xf /backup/${restore_rel}/object-data.tar && find /mnt/workspace-data -mindepth 1 -delete && tar -C /mnt/workspace-data -xf /backup/${restore_rel}/workspace-data.tar"
  if [ -f "${workdir}/codex-home.tar" ]; then
    compose run --rm ops-shell \
      "find /mnt/codex-home -mindepth 1 -delete && tar -C /mnt/codex-home -xf /backup/${restore_rel}/codex-home.tar"
  fi

  log "migration'lar ve runtime rolü tazeleniyor"
  compose run --rm migrate

  log "servisler başlatılıyor"
  compose up -d --wait --wait-timeout 600 workspace-agent control-plane web proxy
  wait_public_ready "$(read_env SELF_HOSTED_PUBLIC_ORIGIN)" 60 ||
    fail "restore sonrası readiness doğrulanamadı"
  log "restore tamam"
}

# ---------------------------------------------------------------------------
# upgrade / rollback
# ---------------------------------------------------------------------------

cmd_upgrade() {
  [ -f "$(env_file)" ] || fail "kurulu bir stack yok (önce install)"
  local new_commit current_commit
  new_commit="$(git -C "${SELF_HOSTED_REPO_ROOT}" rev-parse HEAD)" ||
    fail "upgrade kaynak checkout'u gerektirir"
  [ -z "$(git -C "${SELF_HOSTED_REPO_ROOT}" status --porcelain)" ] ||
    fail "worktree temiz değil — upgrade yalnız temiz checkout'tan yapılır"
  current_commit="$(read_env SELF_HOSTED_SOURCE_COMMIT)"
  if [ "${new_commit}" = "${current_commit}" ]; then
    log "zaten bu sürümde: ${current_commit}"
    return 0
  fi
  if [ -n "${SELF_HOSTED_RELEASE_BUNDLE:-}" ]; then
    cmd_verify_release "${SELF_HOSTED_RELEASE_BUNDLE}"
  fi

  log "upgrade öncesi otomatik yedek alınıyor"
  cmd_backup >/dev/null

  log "yeni product imajı build ediliyor: ${new_commit}"
  docker build \
    -f "${SELF_HOSTED_SCRIPT_DIR}/product.Dockerfile" \
    -t "persistent-self-hosted-product:${new_commit}" \
    "${SELF_HOSTED_REPO_ROOT}"

  update_env_value SELF_HOSTED_SOURCE_COMMIT "${new_commit}"
  update_env_value SELF_HOSTED_PRODUCT_IMAGE "persistent-self-hosted-product:${new_commit}"

  log "migration'lar uygulanıyor"
  compose run --rm migrate

  log "servisler yeni sürüme geçiriliyor"
  compose up -d --wait --wait-timeout 600
  wait_public_ready "$(read_env SELF_HOSTED_PUBLIC_ORIGIN)" 60 ||
    fail "upgrade sonrası readiness doğrulanamadı — 'self-hosted.sh rollback' kullanılabilir"
  write_release_state "${new_commit}"
  log "upgrade tamam: ${current_commit} → ${new_commit}"
}

cmd_rollback() {
  [ -f "$(previous_release_file)" ] || fail "rollback için kayıtlı önceki sürüm yok"
  local previous_commit
  previous_commit="$(sed -n 's/^SELF_HOSTED_SOURCE_COMMIT=//p' "$(previous_release_file)")"
  docker image inspect "persistent-self-hosted-product:${previous_commit}" >/dev/null 2>&1 ||
    fail "önceki sürüm imajı yok: persistent-self-hosted-product:${previous_commit}"
  log "rollback: $(read_env SELF_HOSTED_SOURCE_COMMIT) → ${previous_commit}"
  update_env_value SELF_HOSTED_SOURCE_COMMIT "${previous_commit}"
  update_env_value SELF_HOSTED_PRODUCT_IMAGE "persistent-self-hosted-product:${previous_commit}"
  compose up -d --wait --wait-timeout 600
  wait_public_ready "$(read_env SELF_HOSTED_PUBLIC_ORIGIN)" 60 ||
    fail "rollback sonrası readiness doğrulanamadı"
  mv "$(previous_release_file)" "$(state_dir)/rolled-back-from.env"
  write_release_state "${previous_commit}"
  log "rollback tamam (şema expand-only olduğundan migration geri alınmaz; veri korunur)"
  log "gerekirse upgrade öncesi yedeği 'self-hosted.sh restore' ile uygulayın"
}

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------

cmd_uninstall() {
  local export_path="" skip_export=0 purge=0
  while [ $# -gt 0 ]; do
    case "$1" in
    --export) export_path="$2" && shift ;;
    --skip-export) skip_export=1 ;;
    --purge) purge=1 ;;
    *) fail "bilinmeyen uninstall argümanı: $1" ;;
    esac
    shift
  done
  if [ "${skip_export}" = 0 ]; then
    [ -n "${export_path}" ] ||
      fail "uninstall-with-export varsayılandır: --export <dizin> verin (bilinçli veri imhası için --skip-export)"
    log "son export alınıyor: ${export_path}"
    cmd_backup --include-provider-credentials --output "${export_path}" >/dev/null
  fi

  log "stack kaldırılıyor (yalnız ${SELF_HOSTED_LABEL} etiketli kaynaklar)"
  compose down --volumes --remove-orphans
  docker image ls -q 'persistent-self-hosted-product' | sort -u |
    xargs -r docker image rm -f >/dev/null

  local leftover
  leftover="$(labeled_resources)"
  [ -z "${leftover}" ] ||
    fail "temizlik doğrulanamadı; kalan etiketli kaynaklar: ${leftover}"
  log "container/volume/network temizliği doğrulandı (sıfır kalıntı)"

  if [ "${purge}" = 1 ]; then
    rm -rf "${SELF_HOSTED_HOME}"
    log "durum dizini kaldırıldı: ${SELF_HOSTED_HOME}"
  else
    log "durum dizini korundu (secret ve yedekler): ${SELF_HOSTED_HOME} — kaldırmak için --purge"
  fi
  log "uninstall tamam"
}

# ---------------------------------------------------------------------------
# giriş noktası
# ---------------------------------------------------------------------------

COMMAND="${1:-}"
[ -n "${COMMAND}" ] || usage
shift

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
  --domain) export SELF_HOSTED_DOMAIN="$2" && shift ;;
  --acme-email) export SELF_HOSTED_ACME_EMAIL="$2" && shift ;;
  --tls-mode) export SELF_HOSTED_TLS_MODE="$2" && shift ;;
  --home) export SELF_HOSTED_HOME="$2" && shift ;;
  --provider-auth=defer) export SELF_HOSTED_PROVIDER_AUTH=defer ;;
  *) ARGS+=("$1") ;;
  esac
  shift
done

case "${COMMAND}" in
preflight) cmd_preflight full ;;
install) cmd_install ;;
status) cmd_status ;;
admin-token) cmd_admin_token ${ARGS[@]+"${ARGS[@]}"} ;;
codex-login) cmd_codex_login ${ARGS[@]+"${ARGS[@]}"} ;;
backup) cmd_backup ${ARGS[@]+"${ARGS[@]}"} ;;
restore) cmd_restore ${ARGS[@]+"${ARGS[@]}"} ;;
upgrade) cmd_upgrade ;;
rollback) cmd_rollback ;;
uninstall) cmd_uninstall ${ARGS[@]+"${ARGS[@]}"} ;;
verify-release) cmd_verify_release ${ARGS[@]+"${ARGS[@]}"} ;;
*) usage ;;
esac
