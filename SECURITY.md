# Güvenlik Politikası / Security Policy

## Reporting a vulnerability (English)

Please report suspected vulnerabilities privately to
**kivancguckiran@gmail.com** with the subject prefix `[SECURITY]`. Do not open
a public issue for security reports. We aim to acknowledge reports within
7 days and to coordinate a fix and disclosure within 90 days.

## Bildirim süreci

Güvenlik açığı şüphelerini public issue açmadan, `[SECURITY]` konu önekiyle
**kivancguckiran@gmail.com** adresine iletin. Bildirimde şunlar yardımcı olur:
etkilenen bileşen/sürüm (commit hash'i), yeniden üretim adımları, etki
değerlendirmesi ve varsa öneri.

Süreç hedefleri:

- 7 gün içinde alındı onayı.
- Doğrulanan bulgular için koordineli düzeltme ve en geç 90 gün içinde
  açıklama (coordinated disclosure). Aktif istismar varsa süre kısalır.
- Düzeltme yayımlanmadan bulgu detayının paylaşılmaması rica edilir.

Şu an için ödüllü bug bounty programı yoktur.

## Kapsam

- **Kapsamda:** Bu repository'deki kaynak kod, build/release script'leri ve
  yayımlanan release artifact'leri.
- **Kapsam dışında:** Üçüncü taraf provider CLI/SDK'ları (Codex, Claude,
  Gemini, Cursor — bulguları ilgili sağlayıcıya bildirin), kullanıcıların
  kendi self-hosted kurulumlarının yapılandırma hataları ve Managed Cloud
  hizmetinin altyapısı (ayrı kanaldan yönetilir).

## Desteklenen sürümler

Güvenlik düzeltmeleri yalnız `main` branch'ine ve en son release'e uygulanır.
Eski release'lere backport garantisi verilmez.

## Güvenlik mimarisi

Tehdit modeli ve güvenlik sınırları için `docs/security/` altındaki belgeler ve
`docs/architecture/` altındaki ADR kayıtları doğruluk kaynağıdır. Secret
politikası `infra/release/wp31-gitleaks.toml` ile zorlanır ve
`pnpm release:public-preflight` her koşuda working tree + tam Git history
taraması yapar (ADR-0031).
