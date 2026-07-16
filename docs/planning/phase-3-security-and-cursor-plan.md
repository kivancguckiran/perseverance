# Cursor provider köprüsü ve Faz 3 — Multi-tenant Security Beta

- Plan durumu: Aktif
- Plan tarihi: 16 Temmuz 2026
- Aktif iş paketi: WP17 — Uygulandı / kabul bekliyor
- Ön koşul: Faz 2 ve WP16 tamamlandı
- Kaynak spesifikasyon: `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`

## 1. Amaç ve faz numarası düzeltmesi

Mevcut uygulama planında Faz 2, provider platformu, durable execution, maliyet ve PWA
kapsamında tamamlandı. Ana ürün spesifikasyonundaki eski Faz 2 ise multi-tenant private
beta anlamına geliyordu. Tarihsel kayıtları yeniden adlandırmak yerine bundan sonraki
sıra şöyledir:

1. WP17 — Cursor Agent provider köprüsü
2. Faz 3 — Multi-tenant Security Beta (WP18–WP20)
3. Faz 4 — Corpus ve mobil ürün
4. Faz 5 — Production hardening

Mevcut tek kiracılı sürüm, Codex veya başka bir provider'ın kullanıcılar arasında
kesinlikle erişim yapamayacağı üretim garantisini henüz vermez. Faz 3'ün amacı bu
garantiyi kimlik, authorization, veri, runtime, ağ, şifreleme ve yönetici erişimi
katmanlarında deny-by-default ve adversarial testlerle kurmaktır.

Server-side ajan çalışırken workspace dosyalarını ve model girdilerini plaintext olarak
işlemek zorundadır. Bu nedenle klasik uçtan uca şifreleme ile server-side agent execution
aynı anda tam olarak sağlanamaz. Bu plan at-rest envelope encryption ve güçlü runtime
izolasyonu sağlar. Sunucunun da plaintext görememesi ayrı client-side agent veya
confidential-computing/attestation mimarisi gerektirir ve Faz 3 kapsamı dışındadır.

## 2. İş paketi özeti

| Paket | Durum                      | Hedef                                                                  |
| ----- | -------------------------- | ---------------------------------------------------------------------- |
| WP17  | Uygulandı / kabul bekliyor | Cursor Agent adapter teslim edildi; bağımsız kabul bekliyor            |
| WP18  | Planlandı                  | OIDC principal, deny-by-default authorization ve tenant data isolation |
| WP19  | Planlandı                  | İzole workspace runtime, ağ, secret ve envelope encryption sınırı      |
| WP20  | Planlandı                  | Support grant/break-glass modeli ve adversarial Faz 3 güvenlik kabulü  |

Her zaman yalnız bir paket aktif olabilir. WP17 tamamlanıp bağımsız kabul edilmeden
WP18'e geçilmez.

## 3. WP17 — Cursor Agent provider adapter

### Hedef

Provider ID'si `cursor` olan, resmi `cursor-agent` CLI yüzeyini kullanan adapter'ı mevcut
provider-neutral lifecycle/capability/usage sözleşmesine eklemek.

### Kapsam

- `cursor-agent` binary readiness, version ve `status` tabanlı auth kontrolü; binary
  yoksa actionable hata, otomatik kurulum yok.
- Headless process `--print --output-format stream-json` ile çalışır. Değişiklik yapan
  modda `--force` varsayılan değildir; yalnız platform approval ve proje permission
  policy'si birlikte izin verirse açılır.
- Auth server-side login veya yalnız environment içindeki `CURSOR_API_KEY` ile sağlanır;
  key argument, process listesi, log, event, fixture veya UI'a yazılmaz.
- `<workspace>/.cursor/cli.json` allow/deny policy'si platform politikasından geniş
  olamaz. `.env`, private key, credential ve workspace dışı path varsayılan deny'dır;
  deny allow'dan üstündür.
- NDJSON bounded incremental parser; `system`, `assistant`, `tool_call` ve terminal
  `result` mapping'leri; bilinmeyen alan/event için raw envelope + `cursor.unknown`.
- `session_id` durable saklanır. Resmi `--resume [chatId]` yüzeyi capability ve contract
  testleriyle desteklenir; version drift halinde sessiz fallback yapılmaz.
- Explicit interrupt bounded signal/escalation uygular; browser disconnect interrupt
  üretmez. Output bounding/backpressure mevcut artifact politikasını kullanır.
- Model/capability UI yalnız doğrulanmış seçenekleri gösterir. Unsupported approval,
  reasoning summary, usage veya cost taklit edilmez; ölçüm yoksa ledger
  `partial/unreconciled` kalır ve sıfır göstermez.
- CLI beta/version drift riski ADR ve capability matrix'te görünürdür.

### Zorunlu kabul

- Fixture: start, assistant stream, tool start/completed, unknown event, terminal
  success/failure, malformed/oversized line ve early EOF.
- Binary missing/version mismatch/auth missing için typed readiness.
- Resume, explicit interrupt, zorunlu kill escalation ve browser disconnect sırasında
  devam eden durable run.
- Output bounding/backpressure, secret redaction ve path/permission policy testleri.
- Conversation UI/API'de Cursor seçimi ve dürüst model/capability görünümü.
- Gerçek opt-in Cursor smoke; login/credential yoksa geçmiş sayılmaz.
- Codex/Claude/Gemini regresyonları ve `pnpm verify`.

### Kapsam dışı

- Cursor CLI'yi otomatik indirmek/güncellemek, Cursor Cloud Agent, Cursor billing
  tahmini, undocumented event'e feature parity atfetmek ve `--force`u global açmak.

### Teslimat commit'i

`feat: add Cursor Agent provider adapter`

## 4. WP18 — Kimlik, authorization ve tenant data isolation

### Hedef

İstemcinin gönderdiği tenant header'larına güvenmek yerine doğrulanmış OIDC principal'dan
org/workspace/session scope türeten; bütün veri ve realtime yüzeylerinde deny-by-default
authorization uygulayan ilk multi-tenant güvenlik sınırını kurmak.

### Kapsam

- OIDC issuer/audience/signature/expiry doğrulaması, short-lived access token ve principal
  ile organization membership modeli.
- Org/workspace/session/artifact düzeyinde RBAC + gerektiğinde ABAC; roller ve policy
  kararları tek versioned authorization service/contract üzerinden geçer.
- API, WebSocket subscribe/ack, event ingest/replay, approval, artifact, attachment,
  usage/cost, audit, cache key ve storage key'de zorunlu principal-derived tenant scope.
- Trusted internal service identity ile end-user principal ayrımı; forged scope header
  ve confused-deputy koruması.
- PostgreSQL tenant kolonları, composite foreign key ve mümkünse RLS policy'leri;
  connection/session context temizliği ve pool reuse testleri. SQLite yalnız lokal
  geliştirme adapter'ı olarak açıkça sınırlandırılır.
- Object storage tenant/workspace prefix'i, kısa ömürlü tek-kapsam signed URL ve replay
  koruması; cache partitioning ve tenant-aware invalidation.
- Immutable authorization allow/deny audit'i; içerik veya secret audit'e yazılmaz.

### Zorunlu kabul

- Tenant A principal ile Tenant B session/event/artifact/attachment/usage erişimi ve
  tahmin edilmiş UUID denemeleri deny.
- WebSocket cross-tenant subscribe/ack, cache poisoning, signed URL reuse/expiry ve DB
  pool/RLS context leakage testleri.
- Her public route için authorization coverage matrisi; eksik policy route'u CI'da
  fail-closed.
- Migration/reopen/rollback, `pnpm verify` ve iki adversarial tenant E2E.

### Teslimat commit'i

`feat: enforce tenant identity and data isolation`

## 5. WP19 — Runtime, ağ, secret ve envelope encryption

### Hedef

Her workspace'i ayrı güçlü runtime ve encrypted storage sınırında çalıştırmak; host,
başka tenant, metadata endpoint, dış ağ ve secret erişimini default-deny yapmak.

### Kapsam

- ADR ile gerçek beta runtime'ını seç: workspace başına mikro-VM veya eşdeğer güçlü
  izole runtime. Control plane workspace filesystem'ini doğrudan mount etmez.
- Workspace başına ayrı encrypted volume; host path mount yasağı, canonical path,
  symlink/traversal ve mount escape koruması.
- Default-deny egress; metadata/link-local engeli, DNS/IP rebinding koruması ve yalnız
  scoped approval/policy ile hedef açma. Tenant runtime'ları birbirine erişemez.
- Workload identity ile kısa ömürlü secret lease; secret dosya/env yaşam döngüsü,
  revocation ve process cleanup. Plaintext secret log/event/trace/fixture yasağı.
- Workspace başına DEK ve tenant/workspace KEK bağlamıyla KMS envelope encryption.
  Hassas DB prompt/output/raw-event alanlarında application-level authenticated
  encryption; attachment/artifact için ayrı encryption context.
- Key rotation, key substitution/context mismatch reddi, backup encryption, restore
  doğrulaması ve crypto-erasure.

### Zorunlu kabul

- Symlink/path traversal, host/mount escape, metadata endpoint ve cross-runtime egress
  denemeleri deny.
- Tenant A ciphertext/DEK/context değerini Tenant B context'iyle decrypt etme ve key
  substitution denemeleri fail-closed.
- Rotation sırasında eski/yeni data erişimi, revoked key, crypto-erasure ve
  backup/restore tenant karışmama testleri.
- Crash/restart sonrası plaintext temp/secret kalıntısı bulunmaması; `pnpm verify` ve
  seçilmiş runtime üzerinde gerçek isolation smoke.

### Teslimat commit'i

`feat: isolate and encrypt tenant workspaces`

## 6. WP20 — Admin access governance ve Faz 3 adversarial kabul

### Hedef

Normal admin rolünün içeriği okuyamadığı, yalnız kullanıcı başlatmalı ve süreli support
grant ile dar kapsamlı erişim sağlandığı yönetim modelini kurmak; Faz 3'ü bütün izolasyon
katmanlarında adversarial testlerle kapatmak.

### Kapsam

- Workspace/session/artifact kapsamlı, gerekçeli, süreli, kullanıcı tarafından başlatılan
  ve erken iptal edilebilir support grant state machine'i.
- JIT privilege, MFA kanıtı ve yüksek riskte çift onay. KMS decrypt yetkisi normal admin
  rolünden ve genel support erişiminden ayrıdır.
- Her view/download/decrypt işlemi immutable audit üretir; grant expiry/revoke anında
  bütün token/signed URL/lease erişimi kesilir.
- Break-glass ayrı policy, alarm, çift onay, kısa TTL ve sonradan kullanıcı bildirimiyle
  sınırlandırılır.
- Tek `pnpm phase3:accept` gate'i: authz coverage, RLS/object/cache isolation,
  runtime/network/path, encryption/rotation/restore, support grant ve break-glass.
- Security runbook, tenant incident/notification, key compromise/rotation ve support
  access prosedürleri.

### Zorunlu kabul

- Admin grantsiz içerik erişimi; süresi dolmuş/iptal grant; yanlış workspace/session/
  artifact scope; MFA/double-approval eksikliği deny.
- Grant ile izinli erişim yalnız belirtilen nesne ve süre için çalışır; bütün access ve
  decrypt eylemleri immutable audit'te görünür.
- Break-glass alarm/iki onay/bildirim zinciri ve tekrar/idempotency testleri.
- WP18 adversarial IDOR/WebSocket/cache/signed URL ile WP19 path/mount/KMS/egress/
  backup-restore testlerinin birleşik, tekrarlanabilir çalışması.
- `pnpm phase3:accept`, `pnpm verify`, production build, security E2E ve temiz çalışma
  ağacı.

### Teslimat commit'i

`feat: complete multi-tenant security beta acceptance`

## 7. Faz 3 exit kriteri

İki adversarial tenant arasında session, event, file, artifact, attachment, usage,
cache, secret, network ve encryption context erişimi fail-closed biçimde ayrıdır. Normal
admin içerik okuyamaz; support grant ve break-glass dar kapsam, süre, onay ve immutable
audit ile uygulanır. Backup/restore, key rotation ve runtime escape testleri geçer.

## 8. Sonraki fazlar

- Faz 4 — Corpus ve mobil ürün: tenant-aware index/corpus, watcher/reindex, native veya
  gelişmiş mobil deneyim ve çoklu cihaz akışları.
- Faz 5 — Production hardening: HA/DR, bölgesellik, SLO/alerting, kapasite/noisy-neighbor,
  pentest, compliance, incident response ve kontrollü rollout.

## 9. Cursor için doğrulanan resmi yüzeyler

- Overview: `https://docs.cursor.com/en/cli/overview`
- Headless: `https://docs.cursor.com/en/cli/headless`
- Output format: `https://docs.cursor.com/en/cli/reference/output-format`
- Permissions: `https://docs.cursor.com/cli/reference/permissions`
- Parameters: `https://docs.cursor.com/en/cli/reference/parameters`

Cursor CLI beta ve otomatik güncelleme eğilimli bir yüzeydir. Adapter pinli/test edilmiş
version aralığı ve fail-closed capability/readiness davranışı olmadan production'a
açılamaz.
