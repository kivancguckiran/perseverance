---
title: Workspace Corpus Index
kind: overview
status: current
updated: 2026-07-15
source_ids:
  - SRC-REPO-001
  - SRC-REPO-003
  - SRC-REPO-004
  - SRC-REPO-005
  - SRC-NOTE-001
  - SRC-NOTE-002
  - SRC-NOTE-003
  - SRC-NOTE-004
  - SRC-NOTE-005
tags:
  - index
  - corpus
---

# Workspace Corpus Index

## Özet

Bu index corpus içindeki sentez sayfalarının giriş noktasıdır. Sorular önce buradan yönlendirilir, önemli iddialar daha sonra [`../sources/index.md`](../sources/index.md) içindeki doğruluk kaynaklarında kontrol edilir.

## Perseverance

- [Sistem görünümü](system-overview.md) — Ürünün control plane/data plane ayrımı ve bu servisin sistemdeki yeri.
- [Control-plane servisi](control-plane-service.md) — Fastify API, `SessionOrchestrator`, storage ve realtime sorumlulukları.
- [Event yaşam döngüsü](event-lifecycle.md) — Codex raw mesajından durable timeline, replay ve completed reconciliation akışına kadar olay yolu.

## Güvenlik ve kararlar

- [Güvenlik sınırları](security-boundaries.md) — Tenant scope, path güvenliği, secret redaction, approval ve bounded output değişmezleri.
- [Karar ve roadmap özeti](decisions-and-roadmap.md) — Kabul edilmiş ADR çizgisi, tamamlanan fazlar ve corpus'un ürün roadmap'indeki yeri.

## Nefs-i emmarenin sıfatları

- [Seri görünümü](nefsi-emmarenin-sifatlari.md) — Beş metnin kapsamı, ortak hareketi ve birbirleriyle ilişkisi.
- [Zemin, sahne ve hakikat](zemin-sahne-hakikat.md) — Metinler boyunca benlik, görünür tecrübe ve hakikat arasındaki ortak kavramsal eksen.
- [Ucb](ucb.md) — Benliğin kendisini ölçüye dönüştürmesi ve manevî görünürlük arzusu.
- [Zan](zan.md) — Belirsizliği hükümle kapatma, içeriği dışarıya yansıtma ve hakikate açıklık.
- [Tamah](tamah.md) — İç eksikliği sahiplik, görünürlük ve sürekli “daha” ile örtme döngüsü.
- [Gazap](gazap.md) — Bastırılmış adaletin donmuş kimlik, güvensizlik ve bağ kaybına dönüşmesi.
- [Yalan](yalan.md) — Hakikatin yerine kurgu koymanın benlikten topluma yayılan çürümesi.

## Operasyon

- Corpus bakım kuralları: [`../AGENTS.md`](../AGENTS.md)
- Kaynak registry: [`../sources/index.md`](../sources/index.md)
- Kronolojik işlem kaydı: [`../log.md`](../log.md)
