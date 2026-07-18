# ADR-0023: PWA-first mobil approval, Web Push ve çoklu cihaz sürekliliği

- Durum: Kabul edildi
- Tarih: 18 Temmuz 2026
- Kapsam: WP23

## Bağlam

Durable run, session replay, realtime high-water ve approval CAS mekanikleri browser
ömründen bağımsızdır. Mobil ürünün bu mekanikleri kopyalaması ikinci bir execution veya
approval doğruluk kaynağı yaratır. Native shell açmak da ölçülmüş bir platform boşluğu
olmadan dağıtım, auth ve lifecycle yüzeyini gereksiz büyütür. Web Push endpoint ve key
materyali credential gibi ele alınmalı; notification transport'u prompt, output veya
workspace içeriği taşımamalıdır.

## Karar

- WP23 istemcisi PWA-first'tür. Production Vite build; scoped manifest, 192/512 ve
  maskable icon, versioned service worker, kullanıcı kontrollü update activation ve
  offline navigation shell'i birlikte üretir. Native iOS/Android shell açılmaz.
- Native karar ancak PWA kabulünde ölçülen ve web platformuyla giderilemeyen bir boşluk
  için ayrı ADR ile alınabilir. Ölçülecek alanlar güvenilir background delivery,
  platform-specific secure re-auth ve büyük diff/terminal performansıdır.
- Offline shell ve principal/organization/workspace namespaced son history salt-okunur
  kalır. Prompt, turn, approval, attachment, source veya dış yazma offline queue'ya
  alınmaz. Service worker auth taşıyan ya da `/v1`, auth, artifact ve attachment
  response'larını cache'lemez.
- Push contract version 1; device, subscription, notification outbox ve delivery
  receipt'i tenant, organization, workspace ve opaque principal/device binding'iyle
  tanımlar. Aynı device upsert'i endpoint/key rotation'dır. Revoke, sign-out cleanup,
  expiry ve provider invalid-endpoint sonucu subscription'ı terminal duruma taşır.
- Migration `0023_pwa_push_multi_device.sql` PostgreSQL forced RLS, composite
  tenant/organization/workspace foreign key zinciri ve principal-bound policy kullanır.
  Outbox `(notification, subscription)`, receipt `(outbox, attempt)` tekilliğiyle
  duplicate/out-of-order delivery idempotenttir. Claim `SKIP LOCKED`, retry bounded
  exponential backoff kullanır.
- Endpoint ve Web Push `p256dh`/`auth` değerleri `push_subscription` KMS envelope'unda;
  tenant/organization/workspace/subscription/principal AAD bağlamıyla saklanır. Public
  response yalnız endpoint fingerprint'i döndürür. Endpoint, key, provider credential
  veya payload log, event, audit, timeline ve fixture'a yazılmaz.
- Notification payload exact allowlist'tir: version, opaque notification/session/
  approval ID ve genel durum. Prompt, model output, reasoning, command, diff, filename,
  source/citation, tenant adı, API key ve bearer token yasaktır. Service worker unknown
  alan içeren veya schema dışı payload'ı göstermeden reddeder.
- Notification click session route'una gider. Normal authentication ve centralized
  authorization yeniden çalışır; session ile approval REST/realtime'dan tekrar okunur.
  Resolved/expired approval terminal haliyle görünür, revoked/unauthorized/cross-tenant
  resource eylem üretmeden 403/404 olur. Notification tekrar açılması turn veya karar
  göndermez.
- Mobil approval UI exact redakte command/file/network context, risk, scope ve expiry
  özetini gösterir. Eylemler mevcut `expectedVersion`, idempotency key ve CAS yolunu
  kullanır. İlk kazanan upstream'e tek response gönderir; diğer cihaz realtime terminal
  sonucu reconcile eder.
- Browser kapanması durable run'ı interrupt etmez. Reopen aynı session snapshot ve
  high-water replay'e katılır. Auto-scroll yalnız kullanıcı live edge'deyken aktiftir;
  yukarı scroll takip kilidini kaldırır, live edge'e dönüş yeniden açar.

## Sonuçlar ve sınırlar

- Emulator; payload sınırı, retry, invalid endpoint ve idempotency kanıtıdır; production
  Web Push delivery veya gerçek opt-in kanıtı değildir.
- Gerçek VAPID/provider credential yoksa `wp23:accept` provider smoke'unu açıkça
  `not-run` raporlar; emulator sonucunu production delivery diye adlandırmaz.
- Billing/kota WP24'e, native mobil uygulama ise ölçülmüş boşluk ve ayrı karara bırakılır.
