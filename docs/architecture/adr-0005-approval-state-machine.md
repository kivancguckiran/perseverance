# ADR-0005 — Durable approval state machine

- Durum: Kabul önerisi
- Tarih: 2026-07-14
- Kapsam: Faz 0 WP5 command execution ve file change approval akışı

## Bağlam

Codex app-server approval'ları server-initiated JSON-RPC request olarak gönderir. Kararın yalnız isteği üreten canlı process'e bir kez iletilmesi, iki istemcinin eşzamanlı kararının çift etki üretmemesi ve reconnect sonrasında pending durumun bulunabilmesi gerekir.

## Karar

- Approval, tenant/workspace/session scoped bir SQLite kaydıdır. Raw redakte envelope, normalize `approval.requested` event'i ve approval kaydı aynı `BEGIN IMMEDIATE` transaction'ında yazılır.
- Kimlik `(tenant, workspace, runtimeInstanceId, processGeneration, requestId JSON)` için unique'tir; request ID'nin string/number türü JSON olarak korunur.
- Durum makinesi `pending → resolving → resolved` akışını kullanır. Turn completion/interrupt eski pending kayıtları `superseded`, generation/runtime kaybı ve belirsiz crash durumu `expired` yapar.
- Karar CAS işlemi `expectedVersion` ile yapılır. Kazanamayan istemci `APPROVAL_ALREADY_RESOLVED` veya stale sürüm için `APPROVAL_VERSION_CONFLICT` alır.
- HTTP tekrarları tenant/workspace + approval scope'unda `Idempotency-Key` ve canonical body hash ile tutulur. Aynı key/farklı body conflict'tir.
- Upstream response yalnız kayıtlı runtime instance ve process generation hâlâ canlıysa gönderilir. `resolving` sonrasında belirsiz crash'te response yeniden gönderilmez; kayıt unknown-safe biçimde expire edilir.
- Public kararlar `accept`, `accept_for_session`, `decline`, `cancel` ile sınırlıdır. `accept_for_session`, generated response'taki `acceptForSession` değerine çevrilir. Policy amendment nesneleri otomatik kabul edilmez.
- API ve UI yalnız redakte context'i görür; request ID, runtime binding ve raw protocol params public contract'a çıkmaz.
- WebSocket lifecycle değişikliklerini hızlandırır; reconnect doğruluğu durable pending REST sorgusundan gelir.
- File approval context'i yalnız aynı tenant/workspace/session/turn/item kapsamındaki redakte `file.change.*` veya `diff.updated` event'lerinden türetilir. Eşleşme yoksa `diff: null` ve `diffAvailable: false` açıkça taşınır.
- Runtime health `restarting`, `failed` veya `stopped` olduğunda bağlı pending/resolving kayıtlar proaktif expire edilir. Yeni `ready` generation, eski generation kayıtlarını expire eder; yeni process'e response taşınmaz.
- Gerçek approval smoke'u control-plane REST yüzeyinden session/turn/decision çalıştırır ve yalnız ölçüm amacıyla runtime client `respond` çağrı sayısını sarar; smoke kodu doğrudan response göndermez.

## Sonuçlar

Karar öncesi otomatik response yoktur ve concurrent karar tek upstream etki üretir. WP6 genel process/thread recovery kurmadan, eski generation approval'larının yeni process'e taşınması engellenir.
