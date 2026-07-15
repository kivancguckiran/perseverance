---
title: Sistem Görünümü
kind: overview
status: current
updated: 2026-07-15
source_ids:
  - SRC-REPO-005
  - SRC-ADR-0001
  - SRC-ADR-0002
tags:
  - architecture
  - app-server
  - boundaries
---

# Sistem Görünümü

## Özet

Persistent Codex Workspace, gerçek ve pinli `codex app-server` orkestrasyonunu kalıcı bir workspace ürünü olarak sunar. Control plane oturum, replay, approval, audit ve istemci API'lerini yönetirken; workspace data plane Codex sürecini, repository'yi ve kalıcı `CODEX_HOME` alanını taşır.

```text
Web client
    │ REST + WebSocket
    ▼
Control plane ── durable event/session store
    │ WorkspaceRuntimeClient
    ▼
Workspace Agent ── stdio/JSONL ── codex app-server
    │                                  │
    └──────── workspace filesystem ────┘
```

Workspace Agent bir model ajanı değildir; process supervisor ve protocol adapter'dır. App-server internete doğrudan açılmaz. MVP transport'u deneysel WebSocket değil, aynı güvenlik sınırı içindeki `stdio`/JSONL'dir.

## Doğruluk ve türetilmiş katmanlar

- Codex mesajı önce raw envelope olarak korunur.
- UI/domain için versioned normalized event üretilir.
- Completed item veya snapshot, geçici delta görünümünü reconcile eden yetkili son haldir.
- Workspace filesystem ve Git doğruluk kaynağıdır; corpus/wiki ve ilerideki retrieval index türetilmiş katmanlardır.

## İlgili sayfalar

- [Control-plane servisi](control-plane-service.md)
- [Event yaşam döngüsü](event-lifecycle.md)
- [Güvenlik sınırları](security-boundaries.md)
- [Karar ve roadmap özeti](decisions-and-roadmap.md)

## Kaynaklar

- `SRC-REPO-005` — `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`
- `SRC-ADR-0001` — app-server integration kararı
- `SRC-ADR-0002` — PoC technology stack kararı
