# ADR-0011: Durable audit ve bounded alfa metrics

- Durum: Kabul adayı
- Tarih: 15 Temmuz 2026
- Kapsam: Faz 1 WP11 audit, health, readiness ve metrics

## Bağlam

Tek kiracılı alfa session, turn, approval, auth, runtime, recovery ve salt-okunur Git/artifact işlemlerini restart sonrasında açıklayabilmelidir. Prompt, model çıktısı, reasoning, diff, command output, credential veya server-owned path audit ve telemetry yüzeyine taşınamaz. Kimliklerin metric label olması da cardinality'yi sınırsız büyütür.

## Karar

- SQLite schema v6 `audit_records` tablosunu ekler. Satırlar public store API'sinde append-only'dir; tenant/workspace/session scope, actor, allowlist action/outcome, timestamp, correlation/request/trace alanları ve en çok 2 KiB allowlist metadata taşır.
- `(tenant_id, workspace_id, idempotency_key)` tekilliği retry ve yarışları tek kayda indirir. Approval karar audit'i yalnız optimistic-lock yarışını kazanan başarılı karar sonrasında yazılır.
- Audit query yalnız session scope'unda, opaque keyset cursor ile ve en çok 100 kayıt döndürür. Varsayılan retention 30 gün, 10.000 kayıt ve toplam 8 MiB metadata'dır; store insert transaction'ında en eski kayıtlar prune edilir.
- `/healthz` yalnız process liveness döndürür. `/readyz` her çağrıda database bağlantısı/dosya erişimi, artifact root erişimi, workspace/disk ve app-server/auth durumunu gerçek probe ile yeniden ölçer. Başlangıç preflight sonucu runtime doğruluk kaynağı değildir. Her probe iki saniyelik bounded timeout altında typed `ready|failed` check üretir; değer, credential veya path dönmez.
- `/metrics` harici collector gerektirmeyen JSON aggregate döndürür. Metric adı, label adı ve label değeri kod içinde sabit allowlist'tir. Tenant/workspace/session/turn/request kimlikleri, path ve kullanıcı içeriği label olamaz.
- Recorder ve clock injectable'dır. API latency/error, turn duration/outcome/token usage, approval wait, reconnect/replay, app-server restart/crash-loop, artifact byte/status ve runtime/disk health aynı bounded recorder üzerinden üretilir.
- Approval'ın optimistic-lock ile kazanan `resolving -> resolved` geçişi ve tek başarılı `approval.decided` kaydı aynı `BEGIN IMMEDIATE` transaction'ındadır. Session create/status ve recovery start/failure/success geçişleri de kendi audit kayıtlarıyla aynı store transaction'ına alınır. Upstream app-server response'u, process health callback'i, Git subprocess'i ve artifact filesystem erişimi SQLite transaction'ına katılamaz; bunlar idempotency key ile ayrı durable boundary olarak kaydedilir.
- SQLite WAL, `busy_timeout=5000` ve `BEGIN IMMEDIATE` ile iki control-plane/store instance'ını serialize eder. Audit unique key'i tenant/workspace kapsamında hashlenir; lock bekleme sonrasında retry edilen aynı işlem duplicate üretemez. Beş saniyeyi aşan contention dependency failure kabul edilir ve operatör aynı SQLite dosyasına uzun ömürlü harici writer bağlamamalıdır.

## Sonuçlar

Audit içerik deposu veya billing ledger değildir. Harici OTel/Prometheus/Grafana, SIEM export, alerting ve multi-tenant authorization daha sonraki kararlara bırakılmıştır. Lokal retention pruning audit'in operasyonel açıklanabilirlik sınırını görünür ve test edilebilir kılar.
