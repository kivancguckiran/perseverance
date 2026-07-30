# WP39 Teslimat Raporu — Perseverance v1.0.0

- Karar: Tamamlandı
- Tarih: 30 Temmuz 2026
- Release commit: `git rev-parse v1.0.0^{commit}`
- Tag: `v1.0.0`
- Public canonical repository:
  `https://github.com/kivancguckiran/perseverance`
- Mirror: Ayrı mirror yok; `origin` doğrudan public canonical kaynaktır.

## Yönetici kararları

- Önceki çalışma adı yerine ürün/community adı **Perseverance** olarak
  belirlendi.
- GitHub hedefi `kivancguckiran/perseverance`, görünürlük public olarak
  belirlendi.
- Storage ve migration upgrade uyumluluğu için `persistent_codex` PostgreSQL
  şema adı tarihsel internal identifier olarak korundu; package scope'ları,
  imajlar, UI/PWA ve yayın metadata'sı yeniden adlandırıldı.

## Doğrulama özeti

- Host `pnpm verify`: 62 test dosyası / 602 test, typecheck, build ve SSR HTTP
  smoke geçti.
- ARM64 Ubuntu 24.04 + Node 24 `pnpm verify`: aynı 602 test ve build zinciri
  geçti.
- ARM64 gerçek ortam gate sırası:
  `wp32:preflight` → `wp32:test` → `wp37:test` → `wp38:subpath` →
  `wp32:install-smoke` → `wp32:lifecycle` →
  `wp32:credential-scan` → `wp37:privacy`; tümü passed.
- Credential taraması: static 0, runtime 0.
- Redakte ARM64 kanıt bundle'ı SHA-256:
  `cb83339e9b13c9030fb1c7bb54361334cb4d1f52a98e059008937d9620f4b393`.
- `pnpm release:public-preflight`: release commit'inde ardışık iki ACCEPTED
  koşu; evidence dosyaları bayt-aynı.

## Release artifact'i

GitHub `v1.0.0` release'i şu doğrulanabilir self-hosted bundle dosyalarını
taşır:

- `product-oci.tar`
- `self-hosted-dist.tar`
- `release-manifest.json`
- `SHA256SUMS`
- `cosign.pub` ve her artifact için `.sig`
- `provenance.intoto.json`
- `trust-policy.json`

Kesin artifact checksum'ları release'e eklenen `SHA256SUMS` dosyasındadır.
Kaynak commit bütünlüğü `release-manifest.json`,
`provenance.intoto.json` ve `v1.0.0^{commit}` eşitliğiyle doğrulanır:

```bash
bash infra/self-hosted/self-hosted.sh verify-release <bundle-dizini>
```

## Kapanış

`docs/planning/work-package-management.md` ve
`docs/planning/project-closure-plan.md` kapatıldı. Self-hosted dağıtım
desteklenen sınırdır; `cloud` profili kod tabanında kalır fakat işletilen veya
desteklenen bir hizmet değildir. WP35, WP30-E ve managed cloud launch retire
durumundadır.
