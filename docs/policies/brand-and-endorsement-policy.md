# Marka ve endorsement politikası

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP31 (ADR-0031)

## Community ve Managed Cloud ayrımı

- **Community edition**: Bu repository'nin AGPL-3.0-only lisanslı açık kaynak
  sürümüdür. Adı repository adıyla sınırlıdır; herkes lisans koşulları içinde
  kurabilir, değiştirebilir ve dağıtabilir.
- **Managed Cloud**: Ürünün ticari, tenant-isolated hosted sürümüdür ve ayrı
  bir ticari marka altında sunulur. Managed Cloud markası, logosu ve alan
  adları bu repository lisansına dahil değildir; AGPL kodu kullanmak Managed
  Cloud markasını kullanma hakkı vermez.
- Community sürümünü baz alan üçüncü taraf dağıtımlar ve hosted hizmetler
  kendi adlarını kullanmalı, resmî Managed Cloud hizmetiyle karıştırılacak
  adlandırmadan kaçınmalıdır.

## Endorsement beyanları

- Bu proje bağımsız bir community projesidir; OpenAI, Anthropic, Google veya
  Anysphere ile bağlantılı değildir, onlar tarafından desteklenmez ve onaylanmaz.
- "Codex", "Claude", "Gemini" ve "Cursor" ilgili şirketlerin markalarıdır ve
  yalnız birlikte çalışılabilirliği (interoperability) tarif etmek için
  kullanılır (bkz. `NOTICE`).
- Katkıcılar ve dağıtıcılar, proje adına provider'larla ortaklık veya onay
  iması yapamaz.

## Bilinen marka riski: "Codex" adı

Mevcut çalışma adı **Persistent Codex Workspace**, OpenAI'nin "Codex"
markasını içerir. Ürün çok sağlayıcılı hale gelmiştir (Codex, Claude, Gemini,
Cursor) ve adın public launch öncesi hem marka riski hem doğruluk açısından
yeniden değerlendirilmesi gerekir. Bu bir **açık yönetici kararıdır** ve
`docs/operations/public-release-checklist.md` içinde publish öncesi zorunlu
adım olarak listelenir. Yeniden adlandırma WP31 kapsamı dışındadır; karar
verilene kadar README ve NOTICE bağımsızlık beyanlarını açıkça taşır.

## Uygulama

- Marka ihlali veya yanıltıcı endorsement tespitinde önce iletişim, gerekirse
  lisans/marka hukuku yollarına başvuru izlenir.
- Bu politika değişiklikleri ADR gerektirmez; ancak community/cloud sınırını
  değiştiren kararlar ADR ister (ör. ileride WP33 edition contract'ı).
