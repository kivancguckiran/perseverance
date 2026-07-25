# Managed Cloud billing reconciliation

Her beta döneminde hosting, compute, storage ve model satırları ayrı toplanır.
`estimated` satırlar invoice toplamına alınmaz. Subscription quota satırları
non-billable ve monetary amount `null` kalır.

## Sayısal kontrol

Her platform-credit task için:

`maximum reservation = settled usage + released/refunded remainder`

Dönem reconciliation farkı:

`differenceMicros = billable measured usage − usage settlements`

Kabul edilen sonuç `differenceMicros = 0`, unresolved reservation `0` ve duplicate
dedupe key `0`dır. Failed/interrupted task'ın ölçülmüş kullanımı settlement'a,
ölçülemeyen bölümü `incomplete + estimated` kaydına ve kalan üst sınırı refund'a
gider.

Fark sıfır değilse invoice/tahsilat üretme; WP30 rollout'u halt et, ledger watermark,
price catalog version, task outcome ve idempotency key zincirini incele. Manuel
adjustment ayrı append-only entry olmalı; geçmiş satır düzenlenmemelidir.

Gerçek ödeme sağlayıcısı canlı değildir. Emulator sonucu production tahsilatı
kanıtlamaz; production credential/merchant ortamı yoksa kanıt `not-run` kalır.
