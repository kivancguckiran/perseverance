# WP30 production rollout ve rollback runbook

## Amaç ve sahiplik

Bu runbook yalnız yetkilendirilmiş production-benzeri cohort üzerinde WP30 acceptance
ve kontrollü rollout için kullanılır.

| Rol                    | Sorumluluk                                                             |
| ---------------------- | ---------------------------------------------------------------------- |
| Release owner          | Exact commit/artifact, feature flag, promotion ve go/no-go             |
| Security owner         | Pentest scope, assessor key, critical/high retest ve incident game day |
| SRE on-call            | SLO/error budget, load/soak, chaos, halt ve recovery                   |
| Data owner             | Tenant scope, RLS ve rollback integrity                                |
| Billing/Provider owner | Provider rate, billing/push degradation ve kill switch                 |

Rollout yapan kişi bağımsız pentest assessor'ı olamaz. Production signer ve promoter
ayrımı ADR-0029'a göre korunur.

## Ön koşullar

1. Çalışma ağacı exact implementation commit'inde temiz olmalıdır.
2. `WP30_CODEX_BIN` gerçek pinli `0.144.2` binary'sini göstermelidir.
3. Target, realtime endpoint, iki adversarial tenant, yabancı session/object fixture ve
   production golden session hazır olmalıdır.
4. Pentest, chaos ve incident attestation JSON'ları bağımsız Ed25519 imza ve assessor
   public key'iyle teslim edilmelidir.
5. Cloud/paid resource inventory'si sıfır sonuçlu, bağımsız Ed25519 imzalı cleanup
   attestation'ı ile verilmelidir.
6. Rollout DSN yalnız WP30 cohort ortamına gitmeli; mevcut runtime RLS rolü sağlanmalı
   ve migration `0034` önceden uygulanmalıdır.
7. Active security/chaos testing için change ticket onayından sonra
   `WP30_SECURITY_AUTHORIZATION=approved`, `WP30_CHAOS_APPROVED=approved` ve
   `WP30_ROLLOUT_APPROVED=approved` verilmelidir.
8. k6 load süresi hedefi, soak süresi en az `2h`, hedef rate ve SLO threshold'ları
   change ticket'a sabitlenmelidir.

Credential değerleri terminal history, `.env`, task log veya evidence içine
kopyalanmaz; yalnız kısa ömürlü process environment/secret injection kullanılır.

## Rollout

1. `pnpm wp30:preflight` çalıştır; `not-run` varsa ilerleme.
2. `pnpm production:accept` çalıştır. Orchestrator önceki faz kapılarını ve WP30'un tüm
   gerçek kapılarını fail-closed toplar.
3. `internal` gözlem penceresinde SLO, fairness ve error budget sağlanırsa CAS ile
   `design_partner` cohort'una ilerle.
4. Aynı ölçümleri design partner ve limited beta pencerelerinde tekrarla. Feature flag
   kapalı, kill switch açık veya observation unhealthy ise promotion yapma.
5. `production_cohort` promotion'ından sonra halt/rollback drill'i uygula. Candidate
   admission kapanmalı, önceki imzalı digest geri gelmeli ve korunan domain
   checksum'ları değişmemelidir.
6. Bütün kapılar geçerse orchestrator candidate acceptance hash'ini üretir, immutable
   `go` kaydını yazar ve checksum'lı report/evidence bundle oluşturur.

## Halt ve rollback

Şu koşullardan biri rollout'u derhal durdurur: açık critical/high, SLO veya error budget
ihlali, fairness düşüşü, backlog/leak, event gap, approval failure, tenant mixing,
duplicate turn/job, fence violation, secret evidence finding veya assessor imza hatası.

1. Kill switch'i aç ve yeni admission'ı kapat.
2. Rollout kaydını CAS ile `halted` yap; aynı idempotency key'in farklı command hash'i
   reddedilmelidir.
3. Previous artifact signature/provenance'ını ADR-0029 gate'iyle yeniden doğrula.
4. `rolled_back` transition'ını uygula; migration/veri geçmişini geri sarma.
5. Session/event/approval/artifact/usage/corpus/index/billing checksum ve count'larını
   önceki snapshot ile karşılaştır. Veri kaybı veya karışma varsa incident ilan et.
6. Notification, immutable audit, erişim iptali ve postmortem kayıtlarını tamamla.
7. Düzeltme sonrası aynı attack/failure case'leriyle bağımsız retest olmadan yeniden
   promotion yapma.

## Cleanup

`pnpm wp30:cleanup` geçici `persistent.wp30=true` container/volume'larını, WP30 temp
dizinlerini, process ve browser session'larını sıfır doğrular. Paid/cloud resource
envanteri provider console'dan ayrıca kapatılır; bu dış doğrulama olmadan go/no-go
verilmez. Durable rollout/history/go-no-go kayıtları cleanup hedefi değildir.
