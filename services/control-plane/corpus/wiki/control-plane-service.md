---
title: Control-plane Servisi
kind: component
status: current
updated: 2026-07-15
source_ids:
  - SRC-REPO-001
  - SRC-REPO-002
  - SRC-ADR-0004
  - SRC-ADR-0009
  - SRC-ADR-0010
  - SRC-ADR-0011
tags:
  - fastify
  - orchestration
  - api
---

# Control-plane Servisi

## Özet

`@persistent-codex/control-plane`, Fastify tabanlı modüler monolith servisidir. HTTP/WebSocket sınırını kurar, request scope'u doğrular ve Codex runtime yaşam döngüsünü `SessionOrchestrator` üzerinden yönetir.

## Ana bileşenler

- `src/main.ts`: Server-owned alpha config'i çözer, preflight kontrollerini çalıştırır ve yalnız `127.0.0.1` üzerinde servisi başlatır.
- `src/server.ts`: Health/readiness, session, turn, attachment, approval, artifact, audit, Git snapshot, replay ve realtime route'larını kurar.
- `src/session-orchestrator.ts`: Session/thread binding, runtime registry, auth readiness, start/resume/steer/interrupt, Git snapshot, event ingest ve approval delivery akışlarını koordine eder.
- `src/attachment-storage.ts`: Tenant/workspace/session scoped local attachment storage; boyut, media type, path ve symlink kontrolleri uygular.
- `src/metrics.ts`: Cardinality'si sınırlandırılmış counter, histogram ve gauge serilerini üretir.

## API aileleri

| Aile                  | Temel yüzey                                                         |
| --------------------- | ------------------------------------------------------------------- |
| Operasyon             | `/healthz`, `/readyz`, `/metrics`, `/v1/meta`                       |
| Session               | create/list/detail/resume, conversation metadata ve folder yönetimi |
| Turn                  | start, steer, interrupt ve attachment bağlama                       |
| Timeline              | scoped event replay ve `/v1/realtime` WebSocket subscription        |
| Approval              | list/detail ve optimistic-lock decision                             |
| Artifact              | scoped metadata/content ve tek kullanımlık download token           |
| Workspace görünürlüğü | read-only Git snapshot list/refresh                                 |
| Audit                 | session-scoped cursor pagination                                    |

Tüm domain route'ları `x-tenant-id` ve `x-workspace-id` ister; session route'ları URL'deki `sessionId` ile birleşerek storage scope oluşturur.

## Sınırlar

Servis Codex orkestrasyonunu yeniden uygulamaz. `WorkspaceRuntimeClient` üzerinden gerçek app-server'a bağlanır ve generated protocol tiplerini kullanır. Storage implementasyonları lokal alfa için SQLite/local filesystem olabilir; domain scope ve güvenlik semantiği bu adapter'ların üzerinde korunur.

## İlgili sayfalar

- [Sistem görünümü](system-overview.md)
- [Event yaşam döngüsü](event-lifecycle.md)
- [Güvenlik sınırları](security-boundaries.md)

## Kaynaklar

- `SRC-REPO-001` — `src/`
- `SRC-REPO-002` — `package.json`
- `SRC-ADR-0004`, `SRC-ADR-0009`, `SRC-ADR-0010`, `SRC-ADR-0011`
