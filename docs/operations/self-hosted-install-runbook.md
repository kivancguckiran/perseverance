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

Varsayılan durum dizini `/var/lib/persistent-codex`'tir (`--home` ile
değiştirilebilir). Tek dışa açık servis proxy'dir (80/443); diğer tüm servisler
compose iç ağında kalır.

## Kurulum sonrası zorunlu adımlar

1. **Provider auth** (credential yalnız `codex-home` volume'unda kalır):

   ```bash
   bash infra/self-hosted/self-hosted.sh codex-login
   ```

   Kurulum, provider auth hazır olmadan başarı raporlamaz; bilinçli ertelemek
   için `--provider-auth=defer` verin ve daha sonra login olun.

2. **Admin oturumu** (WP34 OAuth login profillerine kadar kayıtlı operatör
   akışı): kısa ömürlü admin token'ı basın ve PWA'da oturuma enjekte edin:

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

   ardından sayfayı yenileyin. Telefonda PWA kurulumu: tarayıcı menüsünden
   "Ana ekrana ekle".

3. **Tam doğrulama**: `bash infra/self-hosted/self-hosted.sh preflight`
   (provider auth dahil) ve `bash infra/self-hosted/self-hosted.sh status`.

## Sık karşılaşılan hatalar

| Belirti                           | Neden / çözüm                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `FAIL dns-resolves`               | Alan adı bu hosta yönelmiyor; DNS kaydını düzeltin veya bilinçli olarak `SELF_HOSTED_SKIP_DNS_CHECK=1` |
| `FAIL ports-80-443-free`          | Başka bir web sunucusu 80/443 kullanıyor; durdurun veya bind adreslerini değiştirin                    |
| `public readiness doğrulanamadı`  | `docker compose ... logs proxy control-plane` inceleyin; ACME modunda Let's Encrypt erişimi gerekir    |
| `provider auth henüz hazır değil` | `self-hosted.sh codex-login` çalıştırın                                                                |

## İlgili belgeler

- ADR: `docs/architecture/adr-0032-self-hosted-distribution.md`
- Upgrade: `self-hosted-upgrade-runbook.md`, Rollback: `self-hosted-rollback-runbook.md`
- Yedek: `self-hosted-backup-restore-runbook.md`, Kaldırma: `self-hosted-uninstall-runbook.md`
- Kabul gate'leri: `pnpm wp32:preflight`, `pnpm wp32:install-smoke`
