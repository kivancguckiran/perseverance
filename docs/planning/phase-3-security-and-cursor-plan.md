# Cursor provider köprüsü ve Faz 3 — Multi-tenant Security Beta

- Plan durumu: Tamamlandı
- Plan tarihi: 16 Temmuz 2026
- Aktif iş paketi: Yok
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

| Paket | Durum      | Hedef                                                                  |
| ----- | ---------- | ---------------------------------------------------------------------- |
| WP17  | Tamamlandı | Cursor Agent adapter teslim edildi ve bağımsız kabul edildi            |
| WP18  | Tamamlandı | OIDC principal, deny-by-default authorization ve tenant data isolation |
| WP19  | Tamamlandı | İzole workspace runtime, ağ, secret ve envelope encryption sınırı      |
| WP20  | Tamamlandı | Support grant/break-glass modeli ve adversarial Faz 3 güvenlik kabulü  |

WP17–WP20 bağımsız kabul edildi. Faz 3 kapandı ve aktif iş paketi kalmadı.

## 3. WP17 — Cursor Agent provider adapter

### Hedef

Provider ID'si `cursor` olan, resmi `cursor-agent` CLI yüzeyini kullanan adapter'ı mevcut
provider-neutral lifecycle/capability/usage sözleşmesine eklemek.

### Kapsam

- `cursor-agent` binary readiness, version ve `status` tabanlı auth kontrolü; binary
  yoksa actionable hata, otomatik kurulum yok.
- Headless process doğrulanmış workspace’te `--print --trust --output-format
stream-json` ile çalışır. `--trust` permission genişletmez. Değişiklik yapan
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
- Exact doğrulanmış release allowlist’i `2026.07.09-a3815c0` ile başlar; yeni tarih veya
  hash fixture ve authenticated gerçek smoke olmadan desteklenmez.

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

### Kabul sonucu

WP17 bağımsız olarak kabul edildi. Uygulama commit'i `761552d`, güncel runtime düzeltme
commit'i `28a3374` üzerinde provider-neutral Cursor adapter, exact doğrulanmış release
allowlist'i, authenticated readiness, bounded stream parser, project permission
politikası, durable resume, interrupt escalation, usage ve UI/API entegrasyonu
doğrulandı. Cursor Agent `2026.07.09-a3815c0` ve model `auto` ile gerçek smoke; start,
tool event, durable session, resume, explicit interrupt, complete usage, unknown-event
koruması ve cleanup aşamalarını geçti. Güncel HEAD'de 6 hedefli dosyada 154 test ile
repository genelinde 17 dosyada 224 test, bütün typecheck'ler, production build ve SSR
HTTP smoke geçti. Production browser acceptance 1280×720 ve 390×844 görünümü,
controlled Service Worker, offline/online replay ve sıfır page error ile tamamlandı.
WP18 tek aktif pakettir.

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

### Kabul sonucu

WP18 bağımsız olarak kabul edildi. Uygulama commit'i `b2478a2` üzerinde versioned OIDC
principal, server-side organization membership, merkezi deny-by-default authorization,
public route/WebSocket coverage, PostgreSQL migration 18 forced RLS, tenant-scoped
object/grant ve principal/org/workspace cache namespace'i doğrulandı. Gerçek
`postgres:17-alpine` / PostgreSQL `17.10` smoke'u non-superuser ve non-`BYPASSRLS`
application rolüyle cross-tenant SELECT/INSERT/UPDATE/DELETE, composite FK,
transaction-context temizliği, pool reuse ve fail-closed readiness kontrollerini geçti.
Gemini CLI `0.50.0` ve `gemini-2.5-pro` gerçek smoke'u start, resume, interrupt, complete
usage ve cleanup ile geçti. Production browser acceptance desktop/mobil, offline/online
ve principal+organization+workspace tenant-switch snapshot isolation'ını sıfır page
error ile tamamladı. Güncel HEAD'de 7 hedefli dosyada 166 test ve repository genelinde
19 dosyada 243 test, 12 workspace typecheck'i, build ve SSR HTTP smoke geçti. WP19 tek
aktif pakettir.

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

### Uygulama sonucu

Version 1 runtime/network/secret/encryption portları, Kata Kubernetes production
driver'ı, local `development_only` driver, default-deny DNS/IP rebinding policy,
workload identity secret lease yaşam döngüsü, AWS KMS ve local test provider ayrımı,
AES-256-GCM envelope ile bounded chunk encryption, rotation, crypto-erasure,
encrypted backup/restore ve idempotent backfill koordinatörü uygulandı. PostgreSQL
migration 19 application-encrypted event alanlarını, artifact/attachment chunk
manifestlerini, workspace crypto state/audit/backfill tablolarını ve forced RLS
policy'lerini ekledi.

Gerçek PostgreSQL 17.10 migration 18+19, idempotent reapply, WP18 forced-RLS regresyonu
ve cross-tenant crypto-state reddi geçti. Local adversarial crypto/network/path/secret
testleri ve rotation/erasure/backup araçları geçti.

2026-07-16 production isolation kanıtı için `eu-central-1` bölgesinde geçici,
inbound erişimsiz tek node K3s `v1.36.2+k3s1` cluster kuruldu. Node
`c7i.xlarge` nested virtualization ve `/dev/kvm` ile Kata Containers `3.31.0`
çalıştırdı; seçilen RuntimeClass `kata-qemu` ve handler `kata-qemu` oldu.
`wp19-encrypted-ebs` StorageClass, AWS-managed EBS key ile şifrelenmiş ayrı geçici
`gp3` volume üzerindeki local PV'yi kullandı. Repository'nin gerçek
`WP19_KATA_RUNTIME_CLASS=kata-qemu
WP19_ENCRYPTED_STORAGE_CLASS=wp19-encrypted-ebs pnpm wp19:runtime-smoke` komutu
başarıyla tamamlandı. Kanıt; guest kernel'in host kernel'den farklı olduğunu,
encrypted PVC'nin bound olduğunu, pod spec'lerinde hostPath bulunmadığını, metadata
erişiminin ve service-account token mount'unun reddedildiğini, default-deny egress'in
ve runtime'lar arası bağlantı denemesinin engellendiğini doğruladı.

Geçici customer-managed AWS KMS key ile gerçek
`WP19_AWS_KMS_KEY_ID=<temporary-key> pnpm wp19:kms-smoke` komutu başarıyla
tamamlandı. Secret içermeyen sonuç `keyIdHash=5c524caf9bd27639`, encrypt/decrypt
round-trip başarılı ve değiştirilmiş `tenantId` encryption context'iyle decrypt
reddedildi. Key ARN, ciphertext ve key ID repository'ye veya bu kayda yazılmadı;
geçici key 7 günlük bekleme penceresiyle `PendingDeletion` durumuna alındı.

Regresyonda `pnpm wp19:postgres` PostgreSQL `17.10` üzerinde geçti ve container'ı
temizledi; `pnpm wp19:test` 11/11, `pnpm wp19:key-rotation`,
`pnpm wp19:crypto-erasure`, `pnpm wp19:backup-restore` ve `pnpm verify` geçti.
Tam doğrulama 20 dosyada 254/254 test, typecheck, production build ve SSR HTTP
smoke'u kapsadı. Kata smoke namespace/pod/PVC kaynakları, PV/StorageClass, SSM
tüneli, EC2 node, encrypted EBS volume, security group, instance profile ve IAM role
silindi; geçici kubeconfig ve yerel kimlik dosyaları kaldırıldı. Bu teslimat kaydı
oluşturulduğunda WP19 bağımsız kabul ve ADR-0017 teyidi bekliyordu.

### Bağımsız kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'i `3e5e6f7`, production isolation kanıt commit'i `18d0dcb`
  mevcut ve WP19 kapsamını taşıyor.
- Kata smoke gerçek K3s cluster üzerinde `kata-qemu` RuntimeClass, hosttan farklı
  guest kernel ve bound encrypted workspace PVC ile geçti. Host path, metadata,
  service-account token, genel egress ve cross-runtime erişim denemeleri reddedildi.
- Gerçek customer-managed AWS KMS anahtarıyla encrypt/decrypt round-trip geçti ve
  değiştirilmiş tenant encryption context'i `InvalidCiphertextException` ile
  reddedildi. Raporlanan key hash'ine karşılık gelen anahtarın customer-managed,
  AWS KMS origin'li ve 23 Temmuz 2026 için `PendingDeletion` durumunda olduğu
  bağımsız salt-okunur kontrolle doğrulandı.
- PostgreSQL 17.10 migration 18+19 idempotent reapply, forced RLS, application
  envelope/chunk manifest alanları ve cross-tenant crypto-state reddiyle geçti.
- Workspace security testleri 11/11; rotation, revoked key, crypto-erasure ve
  encrypted backup/restore cross-tenant reddi araçları başarılıydı.
- `pnpm verify` 20 dosyada 254 test, bütün typecheck'ler, production build ve SSR
  HTTP smoke ile geçti. Çalışma ağacı ve PostgreSQL test container'ı temizdi.

Uygulama commit'leri: `3e5e6f7`, `18d0dcb`.

WP20 Faz 3'ün tek aktif iş paketidir.

## 6. WP20 — Admin access governance ve Faz 3 adversarial kabul

**Teslimat durumu:** Uygulandı / kabul bekliyor. WP20 ve Faz 3 bağımsız kabul öncesinde
tamamlandı sayılmaz; ADR-0018 “Kabul önerisi” durumundadır.

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

### Bağımsız kabul ve Faz 3 kapanış sonucu

Karar: **Tamamlandı**

- WP20 uygulama commit'i `b842d6a` ve production persistence/enforcement düzeltme
  commit'i `f4863e7` mevcut.
- PostgreSQL production repository migration 20'deki grant, approval, JIT lease,
  break-glass, immutable audit, outbox ve revocation epoch kayıtlarına bağlandı.
  Production başlatma durable repository olmadan fail-closed davranıyor.
- Control-plane restart sonrasında pending/active grant, revocation generation,
  consumed lease, audit zinciri ve pending outbox durumu doğru geri geldi.
- JIT lease gerçek content view ve artifact/attachment download yolunda exact scope,
  tek kullanım ve revoke/expiry generation kontrolüyle uygulandı. Normal admin grantsiz
  içeriğe erişemedi.
- KMS operator onayı her iki approval sırasında çalıştı; separation-of-duty ve
  başarısız karar rollback'i doğrulandı. Break-glass API, çift onay, durable alarm,
  revoke ve notification/outbox recovery akışları geçti.
- `pnpm phase3:accept` PostgreSQL 17.10 migration 18–20, WP18–WP20 adversarial
  kontrolleri, persistent-adapter browser E2E, credential scan ve cleanup ile geçti.
  `pnpm verify` 21 dosyada 265 test, bütün typecheck'ler, production build ve SSR HTTP
  smoke'u tamamladı. Browser kabulü 1280x720 ve 390x844 görünümde sıfır page error ve
  secret leak ile geçti.
- Bu kapanış turu önceki WP19 kod yolunu değiştirmediği için maliyetli Kata/AWS KMS
  production profili yeniden kurulmadı. WP19 kabulünde gerçek `kata-qemu`, encrypted
  storage ve customer-managed AWS KMS kanıtı ayrı olarak doğrulanmıştı.
- Çalışma ağacı ve bütün geçici PostgreSQL container'ları temizdi.

Uygulama commit'leri: `b842d6a`, `f4863e7`.

WP20 ve Faz 3 tamamlandı. Aktif iş paketi yoktur.

## 7. Faz 3 exit kriteri

İki adversarial tenant arasında session, event, file, artifact, attachment, usage,
cache, secret, network ve encryption context erişimi fail-closed biçimde ayrıdır. Normal
admin içerik okuyamaz; support grant ve break-glass dar kapsam, süre, onay ve immutable
audit ile uygulanır. Backup/restore, key rotation ve runtime escape testleri geçer.

**Exit durumu:** Karşılandı.

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
