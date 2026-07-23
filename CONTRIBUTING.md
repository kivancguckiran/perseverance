# Katkı Rehberi

Persistent Codex Workspace'e katkı hoş geldiniz. Bu rehber temiz bir
checkout'tan çalışan bir geliştirme ortamına ve kabul edilen bir katkıya giden
yolu tanımlar.

## Gereksinimler

- Node.js 24 (`engines` alanı `>=24.0.0` ister)
- pnpm 9.15.3 (`corepack enable` önerilir; `packageManager` alanı pinlidir)
- Git
- Opsiyonel: sağlayıcı smoke testleri için Codex CLI 0.144.2 ve Docker
  (çekirdek build/test için gerekmez)

## Temiz checkout'tan build ve test

```bash
git clone <repository-url>
cd persistent-codex-workspace
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` tek doğrulama gate'idir: format kontrolü, typecheck, testler,
build ve SSR smoke'unu birlikte çalıştırır. Temiz bir checkout'ta yukarıdaki
adımlar dışında hiçbir manuel adım gerekmez; gerekiyorsa bu bir hatadır, issue
açın.

Lokal geliştirme sunucusu için `README.md` içindeki `pnpm alpha:dev` bölümüne
bakın.

## Değişiklik akışı

1. Değişikliği küçük ve tek amaçlı tutun; davranış değişikliği testle gelir.
2. Commit'ten önce `pnpm verify` geçmelidir.
3. Dokümantasyon dili Türkçedir; kod, tanımlayıcılar ve commit mesajları
   İngilizcedir (mevcut konvansiyon).
4. Mimari kararlar `docs/architecture/adr-XXXX-*.md` kaydı gerektirir.
5. İş paketi disiplini `docs/planning/work-package-management.md` içinde
   tanımlanır.

## Developer Certificate of Origin (DCO)

Katkılar [Developer Certificate of Origin 1.1](https://developercertificate.org)
beyanıyla alınır. Her commit'i `git commit -s` ile imzalayın:

```text
Signed-off-by: Ad Soyad <eposta@example.com>
```

Sign-off, katkınızı repository lisansı (AGPL-3.0-only, bkz. `LICENSE` ve
ADR-0031) altında sunma hakkına sahip olduğunuzu beyan eder. Ayrı bir CLA şu
an istenmez; ileride ticari lisanslama gündeme gelirse yeni katkılar için CLA
ayrı bir kararla duyurulur.

## Secret ve güvenlik kuralları

- Gerçek credential, token veya müşteri verisi hiçbir dosyaya, teste,
  fixture'a veya commit mesajına yazılamaz.
- Test sabitleri kendini etiketlemelidir (ör. `sk-fixture-not-a-real-key`);
  secret politikası `infra/release/wp31-gitleaks.toml` ile zorlanır.
- Güvenlik açığı bildirimi için `SECURITY.md` sürecini kullanın; public issue
  açmayın.

## Destek

Destek kapsamı ve kanalları için `SUPPORT.md` dosyasına bakın.
