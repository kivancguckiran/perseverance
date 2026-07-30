# Self-hosted kurulum runbook'u (WP32)

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP32 (ADR-0032)

## Ön koşullar

- Temiz, desteklenen bir Linux host (x86_64 veya ARM64), en az 2 vCPU, 4 GiB
  bellek, 20 GiB boş disk.
- Docker Engine + docker compose v2 eklentisi.
- `acme` TLS modu için: host'a yönlenen bir DNS A/AAAA kaydı ve dışarıdan
  erişilebilir 80/443 portları. LAN/hava-boşluklu kurulumda `--tls-mode internal`
  kullanılır.
- Kaynak checkout'u (git) veya imzalı release bundle'ı
  (`SELF_HOSTED_RELEASE_BUNDLE=<dizin>`; `self-hosted.sh verify-release` ile
  checksum + cosign imzası + provenance fail-closed doğrulanır).

## Tek komut kurulum

```bash
bash infra/self-hosted/self-hosted.sh install \
  --domain workspace.example.com --acme-email admin@example.com
```

Kurulum sırasıyla şunları yapar; her adım fail-closed'dur:

1. Preflight (OS/mimari, docker, CPU/bellek/disk, portlar, DNS, TLS girdileri,
   registry erişimi). Her eksik, actionable bir hata satırıyla raporlanır.
2. (Bundle kuruluyorsa) checksum + cosign imzası + provenance doğrulaması.
3. Secret üretimi (`openssl rand`): postgres, broker, minio, telemetry salt,
   yedek anahtarı ve identity RSA anahtarı. Tümü `${SELF_HOSTED_HOME}/secrets`
   altında 0600 izinlidir.
4. Pinli imajların çekilip digest'lerinin doğrulanması (`images.env`).
5. Product imajının kaynaktan deterministik build'i.
6. Altyapı servisleri → tracking tablolu migration'lar → ilk admin bootstrap →
   uygulama servisleri.
7. İç healthcheck'ler ve public origin üzerinden `/readyz` doğrulaması.

Varsayılan durum dizini `/var/lib/perseverance`'tir (`--home` ile
değiştirilebilir). Tek dışa açık servis proxy'dir (80/443); diğer tüm servisler
compose iç ağında kalır.

## Kurulum sonrası zorunlu adımlar

1. **Provider auth** (credential yalnız `codex-home` volume'unda kalır):

   ```bash
   bash infra/self-hosted/self-hosted.sh codex-login
   ```

   Kurulum, provider auth hazır olmadan başarı raporlamaz; bilinçli ertelemek
   için `--provider-auth=defer` verin ve daha sonra login olun.

2. **Kullanıcı hesapları (WP37, son kullanıcı akışı)**: izinli kullanıcı
   adlarını belirleyin ve kullanıcılar `https://<domain>/login` üzerinden
   kayıt olsun:

   ```bash
   bash infra/self-hosted/self-hosted.sh set-allowed-users "ayse,mehmet"
   ```

   - Kayıt yalnız allowlist'teki adlara açıktır; liste dışı denemeler
     fail-closed reddedilir ve audit'e düşer.
   - Kayıtta BİR KEZ gösterilen **recovery key** kullanıcı tarafından
     saklanmalıdır: parola unutulursa tek kurtarma yolu budur. Parola ve
     recovery key birlikte kaybolursa konuşma içeriği KALICI olarak
     çözülemez; operatör kurtarma anahtarı bilinçli olarak yoktur
     (ADR-0037). Bu durumda hesap `reset-user --crypto-erase` ile sıfırlanır.
   - Telefonda PWA kurulumu: tarayıcı menüsünden "Ana ekrana ekle"; oturum
     yeniden açılışta parolasız sürer, içerik anahtarı gerektiğinde parola
     yeniden istenir.

   Kullanıcı yönetimi komutları:

   ```bash
   bash infra/self-hosted/self-hosted.sh list-users
   bash infra/self-hosted/self-hosted.sh disable-user <ad>
   bash infra/self-hosted/self-hosted.sh reset-user <ad> --crypto-erase
   ```

3. **Admin oturumu (yalnız operatör/acil akışı; son kullanıcılar /login
   kullanır)**: kısa ömürlü admin token'ı basın ve PWA'da oturuma enjekte
   edin:

   ```bash
   bash infra/self-hosted/self-hosted.sh admin-token
   ```

   Tarayıcıda `https://<domain>` açıkken geliştirici konsolunda:

   ```js
   sessionStorage.setItem(
     'persistent.auth',
     JSON.stringify({ accessToken: '<admin-token çıktısı>' }),
   )
   ```

   ardından sayfayı yenileyin. Admin öznesi kullanıcı organizasyonlarında üye
   değildir ve kullanıcıların şifreli içeriğini açamaz.

4. **Tam doğrulama**: `bash infra/self-hosted/self-hosted.sh preflight`
   (provider auth dahil) ve `bash infra/self-hosted/self-hosted.sh status`.

## Reverse-proxy alt-path'i (subpath) altında kurulum (WP38)

Uygulama, mevcut bir reverse proxy'nin alt-path'i altında tam işlevle
çalışabilir (ADR-0038): PWA kurulumu, service worker/offline replay,
`/v1/realtime` akışı ve tüm API dahil. Tek yapılandırma değeri yeterlidir:

```bash
bash infra/self-hosted/self-hosted.sh install \
  --domain workspace.example.com --tls-mode internal \
  --base-path /workspace
```

Kurallar ve davranış:

- `SELF_HOSTED_BASE_PATH` normalize edilir: başta `/`, sonda `/` yok, boş =
  kök. Segmentler `[A-Za-z0-9._~-]` ile sınırlıdır; `/v1`, `/healthz`,
  `/readyz`, `/assets`, `/events` ile çakışan değerler preflight'ta
  fail-closed reddedilir.
- Base path **build-time**'dır (web bundle'ı Vite `base` ile üretilir): değeri
  değiştirmek `install`/`upgrade` ile yeni bir product imajı build'i
  gerektirir; imaj tag'i base slug'ı içerir
  (`perseverance-self-hosted-product:<commit>-workspace` gibi).
- Kök `/healthz` ve `/readyz` her durumda korunur (monitoring geriye
  uyumluluğu); base altındaki `/{base}/readyz` da control-plane'e gider. Kök
  `/` isteği `/{base}/`'e 308 redirect edilir; diğer base dışı yollar 404'tür.
- Kullanıcı girişi `https://<domain>{base}/login` olur; PWA "Ana ekrana ekle"
  base scope'uyla çalışır (SW `{base}/sw.js` altından kaydedilir).

### Üstteki nginx için örnek `*.location.conf`

Host catch-all'lı (`listen 8080 default_server`) ve `locations-enabled/`
altından `include` edilen path-prefix düzenine birebir uyan örnek —
`locations-enabled/workspace.location.conf`:

```nginx
# Perseverance — /workspace/ alt-path'i (WP38, ADR-0038).
# URI'yi OLDUĞU GİBİ iletin (sonda / olmadan proxy_pass = strip yok);
# uygulama base'i kendisi sahiplenir.
location ^~ /workspace/ {
    proxy_pass https://127.0.0.1:8443;
    proxy_ssl_server_name on;
    proxy_ssl_name workspace.example.com;
    # İç CA / self-signed sertifika kullanıyorsanız (tls-mode internal):
    # proxy_ssl_verify off;

    proxy_set_header Host workspace.example.com;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # /v1/realtime WebSocket upgrade'i için zorunlu:
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Akış (event replay / uzun yanıtlar) için tamponlamayı kapatın:
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Notlar:

- `proxy_pass` hedefi bu kurulumun Caddy proxy'sidir; portları
  `SELF_HOSTED_HTTPS_BIND` ve host port yönlendirmenize göre uyarlayın
  (ör. Caddy 443'ü yalnız loopback'e bağlıysa `https://127.0.0.1:443`).
- `proxy_pass` değerinin sonuna `/` KOYMAYIN: sondaki `/`, nginx'in prefix'i
  söküp iletmesine yol açar; uygulama `/workspace/...` yollarını tam haliyle
  bekler.
- Doğrulama: `curl -k https://127.0.0.1:8443/workspace/readyz` (doğrudan) ve
  nginx üzerinden `curl http://127.0.0.1:8080/workspace/readyz`.
- Sandbox kanıtı: `pnpm wp38:subpath` aynı topolojiyi (Host catch-all +
  path-prefix, URI strip yok) container'lı bir dış proxy ile kurar ve
  manifest/SW scope, kayıt→akış API, realtime upgrade ve offline replay'i
  base altında doğrular.

## Sık karşılaşılan hatalar

| Belirti                           | Neden / çözüm                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `FAIL dns-resolves`               | Alan adı bu hosta yönelmiyor; DNS kaydını düzeltin veya bilinçli olarak `SELF_HOSTED_SKIP_DNS_CHECK=1`     |
| `FAIL ports-80-443-free`          | Başka bir web sunucusu 80/443 kullanıyor; durdurun veya bind adreslerini değiştirin                        |
| `public readiness doğrulanamadı`  | `docker compose ... logs proxy control-plane` inceleyin; ACME modunda Let's Encrypt erişimi gerekir        |
| `provider auth henüz hazır değil` | `self-hosted.sh codex-login` çalıştırın                                                                    |
| Kayıt `500` / PostgreSQL `42501`  | Aday eskiyse güncelleyin; provisioning workspace insertinden önce transaction-local RLS scope bağlamalıdır |

## İlgili belgeler

- ADR: `docs/architecture/adr-0032-self-hosted-distribution.md`,
  `docs/architecture/adr-0037-user-accounts-passphrase-privacy.md` (kullanıcı
  hesapları, anahtar zinciri ve tehdit modeli),
  `docs/architecture/adr-0038-base-path-deployment.md` (subpath deployment)
- Upgrade: `self-hosted-upgrade-runbook.md`, Rollback: `self-hosted-rollback-runbook.md`
- Yedek: `self-hosted-backup-restore-runbook.md`, Kaldırma: `self-hosted-uninstall-runbook.md`
- Kabul gate'leri: `pnpm wp32:preflight`, `pnpm wp32:install-smoke`
