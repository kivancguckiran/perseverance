# Managed Cloud beta exit raporu

- Source commit: `36f41c2bc2c53913fc672eaf1d2dfc12364a7216`
- Artifact SHA-256: **NOT-RUN** — imzalı external artifact sağlanmadı
- Rollout/cohort: **NOT-RUN** — external cohort sağlanmadı
- Rapor sahibi: **atanmadı**
- Acceptance sınıfı: WP35-L passed; WP35-E not-run

## Gate özeti

| Gate                       | Durum                 | Test/ölçüm                                                 | Evidence digest                                                    |
| -------------------------- | --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| wp35:test                  | passed                | 24/24 local contract test                                  | `f9a07f11def0babb48bb2a29e313bc40dbb6a79c40adb9ac188763ed8a716bd4` |
| wp35:onboarding            | passed                | Docker PostgreSQL 17.5, FORCE RLS, 2 tenants               | `d267850b6b7c7e369be10e8435e8ebbbb090c3337b1f53518b5ade5190076c42` |
| wp35:billing               | passed                | local drill, reconciliation difference 0                   | `676f4108f21e72fcfa377b69b783aa5d22326678d3fea73cd84824a8448532f4` |
| wp35:rollout               | passed                | local halt/rollback/capacity drill                         | `f90fcb6157729f2bc9b28773eacb4810773bdb12895b064989f7a6c388886283` |
| wp35:browser-mobile        | passed (WP35-L only)  | 390x844 + 1280x720 local browser; physical device not-run  | `7dec423b0d35ba85f3cf557ea39fae3fa2afdd1bc70c22644a73bc9adc9b1cff` |
| wp35:lifecycle             | passed                | local export/delete/revoke/crypto-erasure drill            | `cb3aa904f78dfce16e6a9a5e20075efc90201c8d56399ad2464067b84b9d912f` |
| wp35:cleanup               | passed                | local residual cleanup                                     | `d616733460cbb2f9f4f25610d3c42d73046e7cbe03732090496e9078af9b39c3` |
| wp35:accept                | passed 2×7/7 (WP35-L) | consecutive run digests `fe55…00d8`, `39ef…5562`           | `33f2788af18c91a8bff9aad3e9307a65c37cc832e37b4b4dbbd7d954037e239e` |
| wp35:external-accept       | not-run               | external environment/attestations absent                   | `3ccfff4ad65f4f07fae77d210f7f37d8f1086ae516252a4a84ecb93b5f2881b5` |
| production:accept (WP30-E) | not-run               | accepted external production report absent                 | required by WP35-E                                                 |
| verify                     | passed                | 59/59 files, 547/547 tests, build + SSR HTTP smoke         | local command result                                               |
| release:public-preflight   | passed                | 341-component SBOM, 0 secret findings, clean HEAD snapshot | `663eac2139d18ef5bd584ad9d2af92722175fbbf57cb48dcc81e9dab7a668d40` |

## Onboarding ve mobil golden

Signup → workspace → provider → first task → closed client → replay adımlarını,
terminal task state'ini ve cleanup sonucunu kaydet. Secret veya kullanıcı verisi
ekleme.

WP35-L sonucu: akış local production composition üzerinde tamamlandı. Fiziksel
cihaz, gerçek OIDC issuer ve external isolated runtime kanıtlanmadığı için WP35-E
sonucu değildir.

Reliability sonucu: iki ardışık 7/7 koşunun her birinden sonra WP35 etiketli
container, volume, network ve process sayısı `0`; run acceptance digest’leri
`fe556676c9f8bcf32de0b22f1ee24b724035b5e1714665dfa51e946be63600d8`
ve
`39efa354abc7929454b371fb57cf3fc79293783e39602b982a630e90ef855562`.

## Billing

Reservation, settlement, refund/release, failed/interrupted usage ve reconciliation
farkını micro-unit cinsinden yaz. Estimated/non-billable satırları ayrıca listele.

WP35-L sonucu: reservation `2000`, settlement `600`, refund/release `1000`
micro-unit; reconciliation farkı `0`. External commercial ledger ve gerçek
failed/interrupted settlement kanıtı **NOT-RUN**.

## Rollout ve incident drill

Internal → design partner → limited beta, capacity halt, incident ve rollback
transition'larını; WP30 record digest'lerini ve açık feature flag kapsamını yaz.

Local halt/rollback/capacity drill geçti. Gerçek internal → design partner →
limited beta geçişi, incident kaydı ve WP30-E record digest’i **NOT-RUN**.

## Lifecycle ve güvenlik

Export/delete, credential revoke/crypto-erasure, orphan runtime, unresolved credit,
critical/high security/privacy bulgularını yaz.

Local export/delete, revoke/crypto-erasure ve cleanup geçti. External security/
privacy attestation ile production cleanup inventory **NOT-RUN**.

## Not-run kontrolleri

Gerçek provider, payment, production isolation ve fiziksel mobil/PWA kontrollerinden
çalışmayanları sebep ve gerekli environment ile açıkça listele. Not-run başarı
değildir.

- İmzalı artifact deployment — artifact/signature/public key yok.
- Gerçek OIDC ve tenant authorization — iki principal token file ve HTTPS target yok.
- Production PostgreSQL/object storage/broker/KMS/isolated runtime — external
  attestation yok.
- Gerçek provider, fiziksel mobil/PWA ve limited beta cohort — external evidence yok.
- Gerçek billing, incident, lifecycle ve cleanup — external evidence yok.
- WP30-E — kabul edilmiş production acceptance report yok.

Çalıştırma: gerekli dosya yolları ve target tanımlandıktan sonra
`pnpm wp35:external-accept`. Tam değişken sözleşmesi
`scripts/wp35-external-accept.ts` içindeki `requiredEnvironment` listesidir.
Attestation içeriği
`docs/security/wp35-external-beta-attestation.schema.json` ile uyumlu olmalı;
attestation ve artifact detached signature dosyaları, PEM public key’leri ve
yalnız owner-readable (`0600`) iki OIDC token dosyası sağlanmalıdır. Canlı
probe’lar deployment metadata için source commit/artifact digest eşleşmesini,
iki principal için own-tenant `200` ve cross-tenant `403/404` sınırını doğrular.

## Exit kararı

- Karar: **no-go**
- Açık riskler: WP35-E ve WP30-E not-run
- Owner ve hedef tarih: external beta owner tarafından atanmalı
