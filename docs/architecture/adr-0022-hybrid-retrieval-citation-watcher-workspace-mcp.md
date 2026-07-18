# ADR-0022: Hybrid corpus retrieval, citation, watcher ve workspace-local MCP

- Durum: Kabul önerisi
- Tarih: 18 Temmuz 2026
- Kapsam: WP22

## Bağlam

WP21 source, immutable revision, chunk, index document, encrypted snapshot ve
append-only embedding usage omurgasını kurdu. Retrieval bu zinciri kopyalamamalı;
tenant/workspace ile source ACL sınırı lexical/vector aday üretiminden sonra
uygulanırsa rank, cache veya MCP yan kanalı yetkisiz bir source'un varlığını
sızdırabilir. Silinmiş ya da superseded revision citation olarak kalırsa cevap artık
doğrulanabilir değildir. Workspace file event'leri sınırsız watcher kuyruğuna veya
idempotent olmayan reindex işlerine dönüşürse reconnect/restart sırasında derived index
doğruluk kaynağından ayrışır.

## Karar

- Search contract schema version 1'dir. `tenantId`, `organizationId`, `workspaceId`,
  bounded query/top-k/token budget/timeout, opaque cursor ve
  `hybrid-rrf-v1` ranking policy taşır. Body scope yetki kanıtı değildir; authenticated
  principal ve server-side membership/workspace scope ile eşleşmek zorundadır.
- Repository contract version 2, WP21 tablolarını genişletir. Paralel corpus registry
  kurulmaz. PostgreSQL expand migration 22 `pgvector`, 384 boyutlu nullable embedding,
  Postgres FTS, source visibility/ACL, workspace path binding, tombstone, cache epoch,
  watcher/reindex ve index migration state tablolarını aynı composite
  tenant/organization/workspace foreign key ve forced-RLS sınırında ekler.
- Vector index contract `corpus-index-v1`, boyut 384'tür. Production embedding adapter'ı
  bu boyutu açıkça bildirmeli; farklı boyut fail-closed olur. Placeholder/null vector
  lexical retrieval'e izin verir fakat semantic quality kanıtı değildir.
- Lexical ve vector adayları ayrı SQL sorgularında üretilir. Her iki sorgu da current
  indexed source/revision, source visibility ve principal ACL koşulunu aday üretmeden
  uygular. Birleştirme deterministic reciprocal-rank fusion (sabit 60), exact phrase
  boost ve source/chunk ID tie-break ile yapılır.
- Sonuç cache'i principal + tenant + organization + workspace + query policy + cache
  epoch ile namespace edilir; entry ve toplam byte limiti vardır. Source/revision/ACL
  mutasyonu epoch artırır. Delete ve supersede derived chunk/index'i transaction içinde
  kaldırır ve tombstone yazar.
- Citation yalnız source'un current, indexed, ACL-allowed immutable revision ve chunk'ı
  için çözümlenir. Source/revision/chunk content hash ile page/line locator response'ta
  birlikte taşınır. Deleted veya superseded revision `CITATION_NOT_FOUND` olur.
- Query embedding ölçümü gerçek production provider reported token sayısıdır ve mevcut
  append-only `usage_ledger` içine `retrieval_embedding_token` + deterministic dedupe
  key ile yazılır. Interrupted çağrı yalnız provider ölçüm bildirdiyse `partial` yazılır;
  sıfır kullanım üretilmez. Fake-test provider ledger kanıtı üretmez.
- Workspace watcher canonical root altında çalışır; debounce ve backlog bounded'dır.
  `.gitignore`, `.codexignore`, `index.ignore` sırasıyla ve ordered negation ile
  deterministik uygulanır. Event idempotency key scope, operation, old/new path ve
  content hash'ten türetilir. Update aynı source altında yeni immutable revision;
  rename aynı source kimliğiyle path/display mutation; delete tombstone'dur.
- Index migration/reindex state'leri `expanding`, `backfilling`, `active`,
  `rolling_back`, `rolled_back`, `failed`; rebuild job'ları checkpoint, lease ve
  idempotency key taşır. Rollback raw snapshot/source revision'ı değiştirmez, yalnız
  derived index version projection'ını değiştirir.
- Workspace-local MCP stdio server yalnız `search_corpus` ve `get_citation` sunar.
  Tenant/organization/workspace tool argümanı değildir; server başlangıcında fixed
  workload identity'den alınır. Tool annotations read-only/non-destructive'dir;
  request/output byte ve token limitlidir. Unknown method/tool safe JSON-RPC error olur.
- MCP initialize instructions ve her tool output'u corpus içeriğini açıkça
  `untrusted_context` olarak işaretler. Corpus metni system/developer/tool instruction
  değildir. Query/source/raw model output/credential log, trace veya error mesajına
  yazılmaz. Gizli chain-of-thought saklanmaz; yalnız mevcut reasoning summary politikası
  geçerlidir.

## Migration ve rollback

Migration 22 expand-only uygulanır: önce extension/nullable vector ve yeni projection
tabloları, sonra versioned backfill, son olarak active version geçişi. Eski
`unembedded-placeholder-v1` satırlar lexical retrieval için okunabilir; semantic yol
null vector'ü atlar. Rollback state machine önce active version'ı eski version'a alır,
in-flight reindex'i interrupt/restart-safe checkpoint'te bırakır ve yeni derived
projection'ı sonradan temizler. Raw snapshot, source ve immutable revision rollback'te
silinmez. Migration 22 fiziksel olarak geri alınmadan önce vector/FTS kullanan binary
drain edilmelidir.

## Sonuçlar ve sınırlar

- ACL sonradan filtre değildir; lexical, vector, cache, citation ve MCP aynı fail-closed
  visibility kararını kullanır.
- Pgvector 384 teknik sözleşmedir, provider/model kalite seçimi değildir. WP22 kabulünde
  deterministic fake embedding yalnız mekanik hybrid/ACL/vector kanıtıdır. Gerçek
  semantic-quality iddiası provider credential'ı ve ayrı quality evaluation olmadan
  yapılamaz.
- Local registry development/test kolaylığı sağlar; production RLS, durability veya
  semantic kalite kanıtı değildir.
- Billing entitlement/kota, push/mobile ve production HA WP23+ kapsamına taşınmaz;
  WP23 bu kararla aktive edilmez.
