# ADR-0029 — Release supply chain, provider canary ve compliance evidence authority

- Durum: Kabul edildi
- Tarih: 2026-07-21
- Kapsam: WP29

## Bağlam

ADR-0012/0014/0015 provider capability ve usage semantiğini, ADR-0026 production
placement authority'sini, ADR-0027 gözlemlenebilirlik ve immutable backup evidence
zincirini, ADR-0028 ise enterprise lifecycle sınırını kurdu. Buna rağmen source'tan
production cohort'a kadar artifact authority, cryptographic provenance, migration
compatibility ve provider upgrade kararı tek bir fail-closed zincir değildir. Scanner
çıktısı veya elle yazılmış bir `passed` alanı release yetkisi sayılamaz.

## Karar

### Trust boundary ve artifact authority

Release authority source repository, temiz exact commit, pinli package manager/lock,
versioned builder identity ve deterministic build command birleşimidir. Production
artifact'ı yalnız immutable SHA-256 digest ile adreslenir. Manifest source commit,
dirty/untracked durumu, builder, platform, dependency lock hash, Codex protocol schema
hash ve build command taşır. Dirty veya untracked source production release authority
olamaz. Acceptance harness yalnız ayrı temporary worktree ya da adı açık
`acceptance-fixture` input'u kullanabilir; bu artifact production admission'a giremez.

İki temiz, izole build aynı normalized input'tan üretilir. Timestamp, uid/gid, absolute
path, file ordering ve archive metadata sabitlenir. Deterministik ilan edilen her
artifact'ın digest'i iki ortamda eşleşmeden release durur. Web, control-plane,
Workspace Agent ve runtime image/artifact aynı manifest authority'sine bağlanır.

### SBOM, provenance, signer ve admission

Deterministik CycloneDX SBOM direct/transitive package, binary, container-layer
component ve license alanlarını içerir. SLSA-compatible in-toto Statement artifact
digest'ini exact source, builder, invocation, dependency lock ve build parameters'a
bağlar. Manifest, artifact, SBOM ve provenance gerçek Ed25519 signature taşır. Local
acceptance ephemeral test trust root ile gerçek sign/verify ve tamper testini yapar;
cloud keyless credential yoksa production keyless sonucu yalnız `not-run` olabilir.

Admission verifier trusted signer identity/public-key fingerprint, signer validity ve
revocation, repository identity, exact source commit, subject digest, predicate type,
dependency lock/schema hash ve signature'ları doğrular. Unsigned, tampered, wrong
digest/repository, expired/revoked signer veya eksik provenance fail-closed reddedilir.
Key material evidence'a yazılmaz; production signer ile promoter aynı authority
değildir.

### Security policy authority

Secret, dependency/image vulnerability, license, TypeScript SAST ve
Docker/Kubernetes/Compose/IaC policy taramaları versioned gate çıktısıdır. Scanner
bulunmaması başarı değildir: zorunlu production gate `blocked`, environment-specific
opsiyonel smoke `not-run` olur. Secret, exploitable critical/high vulnerability,
forbidden license ve critical IaC finding admission'ı durdurur. Allowlist yalnız owner,
gerekçe, expiry ve immutable approval digest'iyle geçerlidir; expired veya mutable
istisna reddedilir. Tracked source, generated artifacts, image filesystem, fixture,
log ve erişilebiliyorsa Git history taranır. Evidence içeriği ayrıca tenant/prompt/
credential marker'larına karşı taranır.

### Migration authority ve compatibility window

Migration state machine `expand → dual-read/write → backfill → validate → contract-ready
→ contracted` olur. Drop/truncate, column narrowing, unbounded rewrite ve tenant/RLS
kaybı linter'da fail-closed'dur. N schema üzerinde N ve N-1 reader/writer gerçek
PostgreSQL ile çalışmadan `contract-ready` olunamaz. Contract adımı ancak eski
reader/writer sayısı sıfır, immutable drain kanıtı ve ayrı approval varsa açılır.
Rollback schema'yı drop etmez; conversation, event high-water, approval, audit,
billing, corpus, SCIM ve lifecycle tablolarını count ve checksum ile korur.

### Provider canary ve rollout authority

Codex, Claude, Gemini ve Cursor version discovery sonucu versioned capability matrix'e
bağlanır. Codex `0.144.2` generated TypeScript/JSON Schema pinli binary'den üretilir;
schema hash/generated drift canary gate'idir. Fixture replay yalnız contract kanıtıdır,
gerçek credential/binary smoke'u gibi raporlanamaz. Unknown event raw redacted envelope
ile korunur ve Codex için `codex.unknown` olur; decode crash yasaktır. Broken schema,
eksik capability, auth incompatibility, approval/usage semantic drift veya aşırı
unknown-event oranı canary'yi durdurur.

Durable rollout durumları `build → verified → internal → canary → limited_cohort →
production_ready`, ayrıca `halted` ve `rolled_back` olur. Her kayıt artifact digest,
provider/runtime version, schema hash, migration compatibility, cohort, previous hash,
version ve idempotency key taşır. Promoter CAS ile ilerler; stale approval, concurrent
promoter ve replayed/farklı command reddedilir. Error, unknown-event, turn failure,
event gap, approval failure veya SLO burn eşiği aşılırsa halt ve önceki imzalı digest'e
rollback yapılır. Provider/runtime-version kill switch yeni admission'ı kapatır.
Rollback durable conversation/event/approval/billing/migration authority'sini mutate
etmez.

### Compliance evidence

SOC 2 ve ISO 27001 control mapping; access review, change management, separation of
duties, vulnerability management, incident response, backup/DR, logging/monitoring,
vendor/provider management, secure development ve release approval alanlarını gerçek
gate run kimliği, artifact digest, owner ve timestamp'e bağlar. Evidence bundle SBOM,
provenance, signature verification, scan, migration, provider canary, rollout/rollback
ve approval kayıtlarını checksum manifestiyle içerir. Kayıtlar append-only previous
hash zinciridir; bundle ayrıca ayrı evidence signer ile imzalanır.

Elle yazılmış `passed: true`, eksik scanner, fixture'ı external smoke gibi etiketleme
veya doğrulanamayan dosya compliance kanıtı değildir. Prompt/output, secret, token,
provider credential ve tenant içeriği bundle'a alınmaz. Acceptance ancak bütün zorunlu
gate çıktıları parse edilip yeniden doğrulandıktan, content scan sıfır bulgu verdikten
ve temporary container/volume/registry artifact/key/process/credential temizliği
kanıtlandıktan sonra `accepted: true` üretebilir.

## Sonuçlar ve sınırlar

Release yalnız exact digest ve doğrulanmış provenance/signature üzerinden ilerler;
tag, filename veya mutable registry etiketi authority değildir. Rollout kaydı product
data authority'si değildir ve rollback migration/veri geçmişini geri sarmaz. Local
ephemeral signer production keyless identity kanıtı sayılmaz. Credential veya provider
binary bulunmayan Claude/Gemini/Cursor smoke'ları ile cloud keyless doğrulaması açıkça
`not-run` kalır. WP30 bu ADR ile aktive edilmez ve WP29 planlarda tamamlandı olarak
işaretlenmez.
