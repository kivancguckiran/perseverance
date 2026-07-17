# ADR-0021: Corpus doğruluk kaynağı ve MVP vector backend yönü

- Durum: Kabul önerisi
- Tarih: 17 Temmuz 2026
- Kapsam: WP21 source registry, extraction, chunk ve derived index temeli

## Bağlam

Corpus ingestion; yeniden başlatma, parser değişimi ve embedding model geçişlerinde
yeniden üretilebilir olmalıdır. Tenant sınırı yalnız retrieval sırasında değil raw
snapshot, job, chunk, index ve kullanım kaydında da zorunludur. WP21 vector arama
kalitesini veya performansını ölçmez; hybrid retrieval ve workspace-local MCP WP22
kapsamındadır.

## Karar

Dosya sistemi ve immutable yükleme snapshot'ları içerik doğruluk kaynağıdır.
`Source` ve `SourceRevision` manifestleri snapshot hash'i ile bu kaynağı tanımlar.
`CorpusChunk` ve `IndexDocument` tamamen derived data'dır; source revision'dan silinip
deterministik olarak yeniden üretilebilir.

MVP vector backend yönü PostgreSQL `pgvector` olacaktır. WP21 migration'ı extension
ve vector kolonunu zorunlu kılmaz; placeholder index document yalnız embedding
version ve ölçülen token miktarını kaydeder. Gerçek embedding ve vector boyutu
seçildiğinde WP22 expand migration ile vector kolonunu ekleyecektir. Bu seçim için
ölçülmemiş throughput, latency veya corpus boyutu iddiası yapılmaz.

Embedding kullanımı append-only `usage_ledger` içinde
`meter = index_embedding_token` ve revision/embedding-version temelli unique dedupe
key ile kaydedilir. Interrupted veya failed iş `partial` kalır; sıfır kullanım
uydurulmaz.

Production ingestion yalnız versioned `CorpusRepository` PostgreSQL adapter'ı ve
versioned, encrypted `CorpusSnapshotStorage` adapter'ı birlikte sağlandığında açılır;
eksik adapter ile control-plane fail-closed başlar. PostgreSQL metadata transaction'ı
ile immutable object write atomik olamayacağı için pre-commit hata orphan snapshot'ı
hemen siler, post-commit cleanup hatası tenant-scoped durable cleanup outbox'a yazılır.

`LocalCorpusRegistry` ve plaintext `LocalCorpusSnapshotStorage` yalnız açıkça
`test`/`development` seçilmiş adapter'lardır. Bunların test sonucu production corpus
durability, RLS veya worker concurrency kanıtı sayılmaz. Production kanıtı gerçek
PostgreSQL repository, encrypted snapshot adapter ve API/worker restart smoke'undan
gelir.

PDF parser control-plane dışında Poppler child process olarak çalışır. Production
Linux runtime child'a `prlimit` ile address-space sınırı uygular ve limiter yoksa
fail-closed davranır; test/development macOS yolu byte/page/output sınırları ve gerçek
timeout kill ile doğrulanır.

## Sonuçlar

- Index kaybı raw snapshot ve revision metadata kaybı değildir.
- Rebuild aynı chunk policy ve parser version ile aynı chunk kimliklerini üretir.
- Storage key ve bütün PostgreSQL corpus tabloları tenant, organization ve workspace
  scope taşır; forced RLS bağlantı context'i yokken fail-closed davranır.
- Attachment geçici conversation girdisi olarak kalır. Durable source, attachment
  kimliği veya lifecycle'ı reuse etmez; yalnız güvenli yerel storage ilkelerini reuse
  eder.
- Hybrid ranking, citation tool'u ve watcher WP22'ye aittir. WP21 yalnız
  `EmbeddingProvider` port'unu ve doğru usage muhasebesini kurar; placeholder veya
  fake-test provider billable usage üretmez.
