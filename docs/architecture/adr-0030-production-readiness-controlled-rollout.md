# ADR-0030 — Production readiness kanıtı ve kontrollü cohort authority

- Durum: Kabul edildi
- Tarih: 2026-07-22
- Kapsam: WP30

## Bağlam

ADR-0026 production placement/fencing, ADR-0027 SLO/DR, ADR-0028 enterprise
lifecycle ve ADR-0029 release supply-chain authority'sini kurdu. Bunlar tek başına
bağımsız pentest/retest, hedef yükte uzun soak, gerçek failure injection, security
incident game day ve tenant-scoped production cohort kararını kanıtlamaz. Unit test,
fixture veya elle yazılmış `passed` kaydı production authority olamaz.

## Karar

### Kanıt sınıfları ve fail-closed orchestration

`pnpm production:accept` temiz exact implementation commit'inde başlar. Credential,
production-benzeri target, Docker daemon, gerçek Codex binary, authenticated browser
session, mevcut runtime RLS rolü veya bağımsız assessor imzasından biri eksikse
preflight `not-run` üretir ve orchestrator başarısız olur. `not-run`, `skipped` veya
fixture sonucu hiçbir koşulda başarıya yükseltilmez.

Önceki faz acceptance kapıları yeniden çalıştırılır. WP30 pentest, load/soak, chaos,
incident, rollout ve browser/mobile kapılarının her biri makine-okunur evidence üretir.
Process stdout/stderr ve tool çıktıları hash zincirine alınır. Nihai report ve evidence
bundle ayrı SHA-256 checksum taşır; içerik taraması geçmeden `accepted: true` yazılamaz.

### Pentest authority

ZAP Automation Framework ve Nuclei yetkilendirilmiş target üzerinde gerçek DAST yapar.
Tenant/authz/RLS, artifact, approval, prompt/tool injection, traversal/symlink, SSRF,
secret leakage ve cross-tenant realtime saldırı matrisi bağımsız assessor tarafından
imzalanır. Assessor public key'i, engagement çıktısı ve detached signature birlikte
doğrulanır. Açık critical/high veya tamamlanmamış retest admission'ı durdurur.

Scanner raw çıktısında request/response secret'ları kapatılır; bu, tool çıktısını elle
özetlemek değildir. Tool'un kendi JSON çıktısı `raw` olarak saklanır, ikinci kopya
deterministik evidence redaction'dan geçirilir. Her iki kopyanın checksum'ı kaydedilir.

### Performance ve chaos authority

k6 API, realtime/mobile reconnect, scheduler/event lag, provider rate limit, corpus ve
object streaming yükünü aynı koşuda ölçer. En az iki saat soak zorunludur. SLO,
fairness, backlog ve RSS büyümesi threshold olarak tool'a ve harness'e birlikte
uygulanır; threshold gevşetme evidence geçmişini geçersiz kılar.

API, worker, node, region, broker, cache, PostgreSQL replica, provider, KMS, push ve
billing arızaları process/container injection ile uygulanır. Her senaryoda tenant
mixing, uncontrolled duplicate ve fence violation sıfır; recovery gözlenmiş olmalıdır.
Bağımsız chaos attestation'ı local HA/DR game day evidence'iyle birlikte doğrulanır.

### Durable production rollout authority

Production rollout sırası `internal → design_partner → limited_beta →
production_cohort` olur; `halted` ve `rolled_back` terminal drill durumlarıdır.
Rollout tenant/organization/workspace scope, artifact/previous artifact digest,
feature flag, success/error budget, kill switch, version ve idempotency command hash
taşır. Her promotion adjacent, budget-healthy ve CAS kontrollüdür. Concurrent
promoter'lardan yalnız biri kazanır. Halt kill switch'i açar; rollback yalnız önceki
digest ve veri-integrity karşılaştırması doğrulandıktan sonra yapılır.

History, observation ve go/no-go kayıtları tenant-scoped RLS altındadır. History ve
go/no-go update/delete edilemez. Başarılı acceptance önce candidate report hash'i
üretir, sonra ayrı durable `go` kaydı yazar ve nihai report bu kayıt hash'ini taşır.

### Secret ve kullanıcı içeriği sınırı

Token yalnız child process environment'ına verilir; command line, report, trace veya
fixture'a yazılmaz. Nuclei raw request kaydı kapalıdır. URL userinfo/query kabul
edilmez. Evidence scanner bearer/JWT/private key/cookie/secret assignment ve prompt /
decrypted-content marker'larını fail-closed reddeder. Acceptance bundle plaintext
tenant veya kullanıcı içeriği taşımaz.

## Sonuçlar

WP30 yerel geliştirici laptop'unda credential olmadan tamamlanamaz; bu kasıtlıdır.
Production-benzeri ortamın ve bağımsız assessor'ın kaybı başarı değil `not-run` üretir.
Rollout provası gerçek cohort kayıtlarını bırakır; bunlar geçici kaynak değil immutable
operasyon/audit kaydıdır. Geçici container, volume, browser session, process ve local
credential dosyası acceptance sonunda sıfır olmalıdır.
