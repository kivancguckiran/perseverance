# ADR-0006: Session resume ve recovery

- Durum: Kabul adayı
- Tarih: 14 Temmuz 2026

## Bağlam

Browser ve control-plane belleği dayanıklı session’ın doğruluk kaynağı değildir. Codex rollout geçmişi ise yalnız thread’in oluşturulduğu workspace’e özel `CODEX_HOME` içinde güvenle sürdürülebilir. Crash penceresinde upstream etkinin gerçekleşip gerçekleşmediği bilinmeyebilir.

## Karar

Control plane, browser’dan path kabul etmeden, server-owned root altında `SHA-256(JSON([tenantId, workspaceId]))` ile deterministic home üretir. Root ve alt dizinler canonicalize edilir, `0700` oluşturulur; symlink/non-directory component reddedilir. App-server bu home’u yalnız child environment’ında `CODEX_HOME` olarak alır. Auth/config provisioning server sorumluluğudur: canonical server-owned provisioning source içinden yalnız `auth.json` ve `config.toml` allowlist ile read-only symlink edilir. Source dışına kaçan symlink, değiştirilmiş target veya başka dosya reddedilir; `sessions`, `history.jsonl`, logs, skills, plugin cache ve normal Desktop state’i bağlanmaz. Credential içeriği session DB’sine, event’e, log’a, fixture’a veya API’ye kopyalanmaz.

Durable session ile process runtime ayrıdır. Session `starting`, `active`, `recovering`, `recovery_required` veya `failed` olur; recovery error, son başarılı resume zamanı ve process generation ayrıca saklanır. Runtime bağlılığı API response’unda anlık bir alan olarak hesaplanır.

Resume sırası değişmezdir: scoped session lookup → persistent home ile initialize → `thread/read(includeTurns: true)` → `thread/resume` → thread/session routing restore → active state. Aynı session’daki eşzamanlı çağrılar process içinde coalesce edilir ve `Idempotency-Key` durable kaydı ikinci upstream etkiyi engeller. Snapshot’taki aktif turn, steer/interrupt precondition state’ini yeniden kurar. Completed item ve terminal turn snapshot’ları generated notification biçimine çevrilip mevcut adapter/redaction hattından geçirilir. Önce session/thread/turn/item kimliğiyle var olan authoritative event aranır, sonra `recovery:item:<thread>:<turn>:<item>` veya `recovery:turn:<thread>:<turn>:<status>` stable ingest key’i kullanılır. Raw metadata snapshot method’unu açıkça işaretler; sahte platform kaynağı veya `session.resumed` olayı üretilmez.

Thread bulunamaz, okunamaz, bozuk veya home ile uyumsuzsa `THREAD_NOT_RESUMABLE` durable olarak `recovery_required` durumuna yazılır. Process exit/unavailable, timeout, auth ve diğer transient upstream hataları ayrı kodlarla `recovering` kalır. Thread binding değiştirilmez, timeline silinmez ve otomatik yeni thread açılmaz. UI permanent durumda retry, kullanıcı kararıyla yeni session ve read-only timeline; transient durumda retry ve read-only seçeneklerini sunar.

Startup sırasında turn, resume, steer veya interrupt için `pending` kalan idempotency kayıtları `outcome_unknown` yapılır. Aynı key yeniden upstream’e gönderilmez; istemci açık `RECOVERY_OUTCOME_UNKNOWN` alır. Başarılı steer/interrupt sonucu durable kaydedilir ve aynı key önceki sonucu döndürür. Bu, özellikle interrupt upstream’de gerçekleşip DB completion yazılmadan crash olduğunda ikinci upstream etkiyi önler.

Browser session URL’sinden detail’i yükler, durable cursor’dan replay eder, eventId/sequence ile duplicate engeller ve replay→live high-water protokolünü korur. Approval state ayrıca REST ile reconcile edilir. `turn/steer` zorunlu `expectedTurnId` kullanır; `turn/interrupt` aynı terminal sonucu tekrar döndürebilir ve pending approval’ları supersede eder.

## Sonuçlar

Normal Codex Desktop task deposu PoC session’larıyla karışmaz. Home root kaybı otomatik yeni konuşmayla maskelenmez. Crash-safe yaklaşım bazı belirsiz isteklerde kullanıcı müdahalesi gerektirir; güvenli tekrar davranışı bunun karşılığında korunur.
