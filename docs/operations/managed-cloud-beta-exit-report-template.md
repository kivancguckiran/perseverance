# Managed Cloud beta exit raporu şablonu

- Source commit:
- Artifact SHA-256:
- Rollout/cohort:
- Rapor sahibi:

## Gate özeti

| Gate                     | Durum | Test/ölçüm | Evidence digest |
| ------------------------ | ----- | ---------- | --------------- |
| wp35:test                |       |            |                 |
| wp35:onboarding          |       |            |                 |
| wp35:billing             |       |            |                 |
| wp35:rollout             |       |            |                 |
| wp35:browser-mobile      |       |            |                 |
| wp35:lifecycle           |       |            |                 |
| verify                   |       |            |                 |
| release:public-preflight |       |            |                 |

## Onboarding ve mobil golden

Signup → workspace → provider → first task → closed client → replay adımlarını,
terminal task state'ini ve cleanup sonucunu kaydet. Secret veya kullanıcı verisi
ekleme.

## Billing

Reservation, settlement, refund/release, failed/interrupted usage ve reconciliation
farkını micro-unit cinsinden yaz. Estimated/non-billable satırları ayrıca listele.

## Rollout ve incident drill

Internal → design partner → limited beta, capacity halt, incident ve rollback
transition'larını; WP30 record digest'lerini ve açık feature flag kapsamını yaz.

## Lifecycle ve güvenlik

Export/delete, credential revoke/crypto-erasure, orphan runtime, unresolved credit,
critical/high security/privacy bulgularını yaz.

## Not-run kontrolleri

Gerçek provider, payment, production isolation ve fiziksel mobil/PWA kontrollerinden
çalışmayanları sebep ve gerekli environment ile açıkça listele. Not-run başarı
değildir.

## Exit kararı

- Karar: go / no-go
- Açık riskler:
- Owner ve hedef tarih:
