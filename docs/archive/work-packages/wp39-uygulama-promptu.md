# WP39 Uygulama Prompt'u — v1.0 Release ve Proje Kapanışı

Aşağıdaki prompt, uygulama task'ına olduğu gibi verilebilir. WP38 bağımsız
kabul edilmeden BAŞLATILMAZ (tek aktif iş paketi kuralı). Bu, projenin SON iş
paketidir: kabulüyle proje kapanır.

## Başlamadan önce operatörden alınacak kararlar (bloklayıcı)

Bu WP iki açık yönetici kararını kapatmadan ilerleyemez; task'a başlarken bu
kararlar yazılı olarak elinde olmalı:

1. **Marka kararı:** ürün adındaki "Codex" ifadesinin riski
   (`docs/policies/brand-and-endorsement-policy.md` + WP31 publish
   checklist'indeki zorunlu adım). Karar ya "yeniden adlandır" (yeni ad +
   kapsamlı rename bu WP'de yapılır) ya da "gerekçeli olarak koru" (gerekçe
   policy'ye kayıt düşülür).
2. **Public hedef:** repo'nun yayımlanacağı yer (ör. GitHub org/repo adı),
   görünürlük ve mirror stratejisi (origin push + public mirror).

## İş paketi ve hedef

WP39 — v1.0 release ve proje kapanışı. Hedefin: repository'yi fiilen
yayımlamak, `v1.0.0` sürümünü etiketleyip doğrulanabilir release artifact'iyle
çıkarmak ve projeyi belgelenmiş biçimde kapatmak.

## Yapılacak işler

1. **Marka kararının uygulanması:** karar "yeniden adlandır" ise ad, paket
   adları, imaj etiketleri, dokümantasyon ve UI metinleri dahil tutarlı rename;
   karar "koru" ise policy'ye gerekçe kaydı. Her iki durumda publish
   checklist'in marka maddesi işaretlenir.
2. **Release içeriği:** `CHANGELOG.md` / release notları (WP0'dan bu yana ana
   hatlar; kapanış WP'leri ayrıntılı), sürüm alanları (`package.json` vb.)
   `1.0.0`.
3. **Artifact:** wp29 imza/provenance hattıyla release bundle üretimi
   (SHA256SUMS, cosign imzaları, `release-manifest.json`, `trust-policy.json`,
   `provenance.intoto.json`); yayımlanan bundle üzerinde
   `self-hosted.sh verify-release <bundle>` yeşil.
4. **Destek sınırı beyanı:** README ve dokümantasyonda self-hosted =
   desteklenen dağıtım; `cloud` profili "kod tabanında mevcut, işletilen bir
   hizmet değil ve desteklenmiyor" beyanıyla işaretlenir.
5. **WP31 publish checklist'i uçtan uca:** secret/history taraması dahil tüm
   maddeler işaretli; `pnpm release:public-preflight` release commit'inde
   ardışık iki koşuda ACCEPTED ve evidence bayt-aynı.
6. **Kapanış kayıtları:** `docs/planning/work-package-management.md` belge
   durumu `Kapatıldı`; WP36-WP39 kabul kayıtları ve retire kayıtları (WP35,
   WP30-E, managed cloud launch) son haline getirilir; kapanış exit kriteri
   (`project-closure-plan.md` §4) madde madde karşılanmış olarak işaretlenir.
7. **Yayın:** `v1.0.0` tag'i, origin'e push ve public mirror yayını; temiz bir
   contributor checkout'unda belgelenen adımlarla build/test edilebilirlik
   doğrulanır (README quickstart'ı birebir izlenerek).

## Kapsam dışı işler

- Yeni özellik, yeni provider, yeni dağıtım profili, davranış değişikliği.
- Sürüm sonrası bakım taahhüdü tanımlamak (yalnız mevcut SECURITY.md/support
  kapsamı beyanı geçerlidir).

## Kabul kriterleri

- `pnpm release:public-preflight` release commit'inde ardışık iki koşuda
  ACCEPTED ve evidence bayt-aynı.
- Tag, artifact checksum/imza ve provenance yayımlanan sürümle eşleşir;
  `verify-release` yayımlanan bundle'da geçer.
- Marka kararı kayıt altında; publish checklist'in tüm maddeleri işaretli.
- Public repo temiz bir contributor checkout'unda belgelenen adımlarla
  build/test edilebilir.
- `pnpm verify` geçer; `wp32:*`, `wp37:*`, `wp38:*` gate'leri regresyonsuz.
- Kapanış kayıtları tam: yönetim dokümanı `Kapatıldı`, exit kriterleri işaretli.

## Çalıştırılacak doğrulama komutları

```bash
pnpm verify
pnpm wp32:test && pnpm wp37:test
pnpm wp32:install-smoke && pnpm wp32:lifecycle && pnpm wp32:credential-scan
pnpm wp37:privacy && pnpm wp38:subpath
pnpm release:public-preflight   # 2 kez; evidence hash'leri karşılaştır
# release bundle üretimi sonrası:
bash infra/self-hosted/self-hosted.sh verify-release <bundle-dizini>
```

## Teslimat commit'i

Ana dal WP38 teslimat commit'i üzerindesin. Rename gerekiyorsa o ayrı,
kendi içinde yeşil bir refactor commit'i olabilir (`refactor: rename ...`);
release'in kendisi tek commit:
`chore: release v1.0.0 and close the project`
Teslimat raporuna commit hash'i, tag, artifact checksum'ları, checklist durumu
ve kapanış kaydı yazılır.
