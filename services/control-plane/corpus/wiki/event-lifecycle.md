---
title: Event Yaşam Döngüsü
kind: concept
status: current
updated: 2026-07-15
source_ids:
  - SRC-REPO-001
  - SRC-ADR-0003
  - SRC-ADR-0004
  - SRC-ADR-0005
  - SRC-ADR-0006
  - SRC-ADR-0007
tags:
  - events
  - replay
  - reconciliation
---

# Event Yaşam Döngüsü

## Özet

Bir kullanıcı turn'ü control plane'de kabul edilir, gerçek Codex thread/turn çağrısına çevrilir ve app-server mesajları raw + normalized biçimde atomik olarak kalıcılaştırılır. İstemci önce replay alır, ardından live stream'e geçer; sequence ve completed reconciliation kuralları bağlantı kopmalarında aynı semantiği korur.

## Akış

1. Request, tenant/workspace/session scope ile doğrulanır.
2. `SessionOrchestrator`, tek aktif turn varsayımı altında app-server `turn/start` veya lifecycle çağrısını yapar.
3. Workspace runtime mesajı kaynak version ve runtime-instance ingest key ile alınır.
4. Raw envelope ve normalized timeline event aynı durable işlemde yazılır.
5. Bilinen delta'lar geçici UI state üretir; bilinmeyen item/enum/event `codex.unknown` olarak korunur.
6. `item/completed` veya snapshot geldiğinde client geçici state'i yetkili final içerikle reconcile eder.
7. Reconnect'te client son sequence'i gönderir; server high-water sınırına kadar replay yapar, bu sırada live olayları buffer'lar ve sonra sırayla teslim eder.
8. Queue event/byte sınırını aşarsa sessiz kayıp yerine resync davranışı tetiklenir.

## Approval dalı

Server-initiated approval request durable pending kayda dönüşür. Decision, expected version ve idempotency key ile çözülür. Concurrent iki karardan yalnız biri kazanır ve yalnız o karar app-server'a tek upstream response üretir. Process generation değişirse eski approval yeni runtime'a taşınmaz.

## Büyük command output

Live timeline yalnız bounded preview/tail tutar. Tam output streaming redaction sonrasında tenant/workspace scoped artifact'e spill edilir. Böylece event row ve browser belleği output büyüklüğüyle sınırsız büyümez.

## Recovery

Server-owned persistent `CODEX_HOME`, thread binding'i yeniden okumayı ve `thread/resume` yapmayı sağlar. Recovery hataları auth-required, runtime-unavailable, timeout, transient veya kalıcı `THREAD_NOT_RESUMABLE` sınıflarına ayrılır; başarılı recovery sequence'i sıfırlamaz.

## İlgili sayfalar

- [Sistem görünümü](system-overview.md)
- [Control-plane servisi](control-plane-service.md)
- [Güvenlik sınırları](security-boundaries.md)

## Kaynaklar

- `SRC-ADR-0003` — atomic ingest ve replay
- `SRC-ADR-0004` — runtime orchestration
- `SRC-ADR-0005` — approval state machine
- `SRC-ADR-0006` — recovery
- `SRC-ADR-0007` — bounded output artifact
