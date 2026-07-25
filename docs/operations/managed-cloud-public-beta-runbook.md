# Managed Cloud kontrollü public beta runbook

## Amaç ve sahiplik

Bu runbook internal, design partner ve limited public beta operasyonunu kapsar.
Incident Commander rollout/halt kararının, Platform on-call runtime/kapasitenin,
Billing on-call reconciliation'ın, Security on-call abuse/provider terms ve
credential olaylarının sahibidir. Karar kaydı WP30 production-readiness
go/no-go zincirinde tutulur.

## SLO ve error budget

Beta SLO'ları:

- onboarding başarı oranı: aylık en az %99;
- accepted durable task terminal sonuç oranı: aylık en az %99,5;
- reconnect sonrası replay p95: en çok 2 saniye;
- task event lag p95: en çok 5 saniye;
- billing ledger/reconciliation farkı: 0 micro-unit;
- tenant scope, data loss, uncontrolled duplicate ve fence violation: 0.

Error budget burn rate 1'i aşarsa yeni cohort ilerletilmez; 2'yi aşarsa veya data
loss/security/privacy critical/high bulgusu varsa rollout derhal halt edilir.

## Kademe geçişi

1. Artifact digest, migration evidence ve feature flag kapsamını kaydet.
2. WP30 budget observation ve go/no-go kaydını üret.
3. `internal → design_partner → limited_beta` sırasında yalnız bir kademe ilerle.
4. Her kademede capacity ceiling, requests/minute ve abuse sinyallerini doğrula.
5. WP35 onboarding, billing, browser/mobile ve lifecycle kanıtı geçmeden ilerleme.

`managed_cloud_beta_admissions` karar vermez; yalnız WP30'da kabul edilmiş
rollout/cohort'a tenant bağlar.

## Halt

Aşağıdakilerden biri halt sebebidir:

- quota/budget/capacity admission'ın fail-open olması;
- provider capability veya kill switch bypass;
- billing reconciliation farkı;
- SLO/error budget ihlali;
- critical/high security veya privacy bulgusu;
- provider terms değişikliği;
- operator kararı.

Halt sırasında feature flag ve kill switch WP30/WP34 kaynaklarında kapatılır. Yeni
signup, task, provider lease ve reservation reddedilir. Çalışan durable task'lar
ADR-0026 drain/fencing ile güvenli terminal duruma gelir; ölçülen kullanım settle,
kalan rezervasyon release/refund edilir.

## Rollback

1. Halt kaydını ve neden kodunu oluştur.
2. Önceki artifact digest'ini doğrula.
3. WP30 `rolled_back` transition'ını `rollbackVerified=true` ile uygula.
4. Migration forward-compatible ise schema'yı geriye alma; uygulamayı önceki
   artifact'e döndür.
5. Replay, tenant isolation, provider revoke ve billing invariant smoke çalıştır.
6. Capacity admission'ları kapalı bırak; yeni go/no-go olmadan açma.

## Incident ve escalation

SEV-1: tenant sınırı, secret exposure, data loss, yanlış tahsilat veya yaygın
task kaybı. Beş dakika içinde IC çağrılır, rollout halt edilir ve Security/Privacy/
Billing sahipleri eklenir. SEV-2: SLO veya kısıtlı cohort etkisi; 15 dakika içinde
on-call ve ürün sahibi bilgilendirilir. Kullanıcı iletişimi doğrulanmış etki,
geçici önlem, veri kapsamı ve bir sonraki güncelleme zamanını içerir; credential
ve tenant verisi içermez.

## Cleanup

Test tenant'ları WP28 delete job → WP34 revoke/crypto-erasure → WP33 tenant delete/
reconcile sırasıyla temizlenir. Push subscriptions WP23 hattından revoke edilir.
Orphan runtime ve unresolved credit reservation sayıları sıfır olmalıdır.
