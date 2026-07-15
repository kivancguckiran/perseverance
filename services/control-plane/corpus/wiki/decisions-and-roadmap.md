---
title: Kararlar ve Roadmap
kind: decision
status: current
updated: 2026-07-15
source_ids:
  - SRC-REPO-003
  - SRC-REPO-004
  - SRC-REPO-005
  - SRC-ADR-0001
  - SRC-ADR-0002
  - SRC-ADR-0003
  - SRC-ADR-0004
  - SRC-ADR-0005
  - SRC-ADR-0006
  - SRC-ADR-0007
  - SRC-ADR-0009
  - SRC-ADR-0010
  - SRC-ADR-0011
tags:
  - adr
  - roadmap
  - corpus
---

# Kararlar ve Roadmap

## Özet

Faz 0 protocol proof ve Faz 1 tek kiracılı alfa tamamlanmıştır. Kabul edilen mimari çizgi gerçek app-server, generated protocol, raw + normalized event, durable replay, idempotent approval, persistent recovery, bounded artifact, read-only Git visibility ve durable audit/metrics kararlarından oluşur.

## Karar zinciri

| ADR  | Kalıcı karar                                                                          |
| ---- | ------------------------------------------------------------------------------------- |
| 0001 | Codex orkestrasyonu yeniden yazılmaz; gerçek app-server `stdio`/JSONL ile kullanılır. |
| 0002 | PoC pnpm/TypeScript monorepo, Fastify, SQLite ve pinli Codex sürümü üzerinde kurulur. |
| 0003 | Raw + normalized ingest atomik; replay tenant-scoped ve sequence tabanlıdır.          |
| 0004 | Runtime instance identity ve thread/turn lifecycle collision-safe yönetilir.          |
| 0005 | Approval durable, optimistic-lock ve idempotenttir; tek upstream etki üretir.         |
| 0006 | Persistent `CODEX_HOME` ile aynı thread restart sonrasında resume edilir.             |
| 0007 | Büyük command output bounded preview + redacted artifact olarak saklanır.             |
| 0009 | Lokal alpha auth bootstrap server-owned preflight ile ve secret kopyalamadan yapılır. |
| 0010 | Workspace/Git görünürlüğü canonical ve salt-okunurdur.                                |
| 0011 | Audit durable hash chain, metrics bounded-cardinality yaklaşımını izler.              |

## Corpus konumu

Ürün spesifikasyonu corpus'u Faz 3'te source registry, extraction, hybrid search ve workspace-local MCP retrieval olarak konumlandırır. Bu dizindeki Markdown corpus daha küçük ve bugünden yararlı bir bilgi katmanıdır; production retrieval servisini veya tenant ACL modelini uyguladığı iddiasında değildir.

Bu ayrım önemlidir:

- Repo corpus'u: Git-versioned Markdown, insan/ajan bakımında, local engineering knowledge.
- Ürün corpus'u: Tenant/workspace scoped ingestion, extract/chunk/index, ACL-filtered retrieval ve tombstone lifecycle.

Gelecekte ürün corpus'u uygulanırken filesystem/source manifest doğruluk kaynağı kalmalı; embedding ve search index yeniden üretilebilir türev olmalıdır. Bu güvenlik/protokol/veri modeli sınırını etkilediği için implementasyon öncesinde ayrı ADR gerekir.

## Açık sorular

- Faz 2 multi-tenant private beta'nın kesin iş paketleri ve kabul sırası henüz bu corpus'a ingest edilmedi.
- Production corpus'un source registry şeması, ACL semantiği, retention ve deletion davranışı ayrı karara ihtiyaç duyar.
- Wiki sayfalarının ölçeği yüzlerce sayfaya ulaştığında BM25/vector arama ekleme eşiği ölçülmelidir; bugünkü index dosyası yeterlidir.

## İlgili sayfalar

- [Sistem görünümü](system-overview.md)
- [Event yaşam döngüsü](event-lifecycle.md)
- [Güvenlik sınırları](security-boundaries.md)

## Kaynaklar

- `SRC-REPO-003`, `SRC-REPO-004`, `SRC-REPO-005`
- `SRC-ADR-0001`–`SRC-ADR-0011` (registry'de listelenen kabul edilmiş kayıtlar)
