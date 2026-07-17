# ADR-0018: Admin içerik ayrımı, support JIT grant, break-glass ve immutable audit

- Durum: Kabul önerisi
- Tarih: 17 Temmuz 2026
- Kapsam: Faz 3 WP20

## Bağlam

WP18 principal, merkezi authorization ve forced RLS; WP19 runtime, egress, secret lease
ve envelope encryption sınırlarını kurdu. Bu sınırlar platform personelinin tenant
içeriğine hangi koşullarla erişebileceğini tek başına tanımlamaz. Kalıcı admin yetkisi,
geniş support rolleri veya genel KMS decrypt izni tenant izolasyonunu içeriden aşabilir.

## Karar

- Organization `admin`, platform `support` ve `operator` rolleri prompt, output, raw
  event, attachment, artifact ve decrypt eylemlerini rol gücüyle alamaz. Tenant owner,
  developer ve viewer ürün içeriğine kendi kullanıcı yetkileriyle erişmeye devam eder.
- Version 1 support grant yalnız tenant kullanıcısı tarafından, açık workspace/session/
  object/action, yazılı gerekçe ve 5–60 dakika TTL ile başlatılır. Support veya admin
  kendi grant'ini oluşturamaz ve mevcut scope'u genişletemez.
- Grant durumları `pending_verification → pending_approval → active` ile `denied`,
  `revoked`, `expired` terminalleridir. Her mutasyon optimistic version ve idempotency
  key kullanır.
- Download ve decrypt yüksek risklidir; güçlü MFA ve birbirinden farklı iki yetkili
  principal ister. Requester, support principal ve approver ayrımı zorunludur. Decrypt
  lease'i yalnız ayrı `kms_operator` rolüne verilir.
- JIT lease en çok beş dakikadır; grant scope, principal ve generation'a bağlıdır,
  bearer değeri yalnız bir kez döner ve kalıcı olarak yalnız hash'i tutulur. Consume
  tek kullanımlıdır. Revoke/expiry generation artırır ve lease/signed araçları derhal
  geçersizleştirir.
- Break-glass support grant'ten ayrı state machine'dir: geçerli incident ID, güçlü MFA,
  farklı iki approver, açık session/object/action ve en çok 15 dakika TTL ister.
  Aktivasyondan önce durable alarm outbox kaydı oluşur; bitişte tenant notification
  outbox kaydı oluşur. Delivery sonucu erişim kararından ayrı izlenir.
- Her grant, MFA, approval, activation, view/download/decrypt, lease, revoke/expiry,
  break-glass, alarm ve notification eylemi plaintext içerik taşımayan append-only audit
  üretir. PostgreSQL zinciri workspace başına satır kilitli head ve SHA-256 record hash
  ile eşzamanlı insert'lerde doğrulanır. Application rolünün audit update/delete/insert
  yetkisi yoktur; append yalnız tenant-context doğrulayan function üzerinden yapılır.
- Production güvenlik kabulü gerçek Kata RuntimeClass, encrypted storage class ve AWS
  KMS customer-managed key ister. Local process ve local-memory KMS sonuçları production
  isolation kanıtı değildir.

## Sonuçlar

Support operasyonu kullanıcı görünürlüğü ve erken revoke gerektirir. Alarm veya tenant
notification teslim arızası erişim kararını geri almaz; durable outbox retry edilir ve
iki sonuç ayrı audit edilir. ADR bağımsız güvenlik kabulüne kadar “Kabul önerisi” kalır.
