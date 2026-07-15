---
title: Güvenlik Sınırları
kind: concept
status: current
updated: 2026-07-15
source_ids:
  - SRC-REPO-001
  - SRC-REPO-005
  - SRC-ADR-0005
  - SRC-ADR-0007
  - SRC-ADR-0009
  - SRC-ADR-0010
  - SRC-ADR-0011
tags:
  - security
  - tenant-scope
  - secrets
---

# Güvenlik Sınırları

## Özet

Control plane paylaşımlı yönetim yüzeyi, workspace ise dosya/process/ağ güvenlik sınırıdır. Lokal alfa tek tenant olsa bile domain kayıtları, storage key'leri ve route'lar tenant ile workspace scope'unu açık taşır; bu, ilerideki izolasyonun ertelenmiş bir kontrol değil mevcut veri modeli özelliği olmasını sağlar.

## Değişmezler

- Her domain ve storage erişimi `tenantId`, `workspaceId` ve gerekiyorsa `sessionId` ile scope edilir.
- Browser çalışma dizini seçemez; workspace path server-owned config'den gelir.
- Dosya path'leri canonicalize edilir; traversal, symlink escape, `/proc` ve `/sys` erişimi reddedilir.
- Credential içeriği event, audit, metric, fixture, log, API response veya corpus'a yazılmaz.
- Raw event saklama, hassas alanları redaction/encryption policy olmadan kalıcılaştırmaz.
- Ağ ve dış yazma default-deny'dır; approval kapsamı açık ve kararı idempotenttir.
- App-server public network endpoint olarak sunulmaz.
- Gizli chain-of-thought istenmez veya depolanmaz; yalnız protokolün açık reasoning summary yüzeyi kullanılabilir.
- Büyük output bounded preview ve scoped artifact ile yönetilir.

## Attachment örneği

`LocalAttachmentStorage`, scope parçalarını allowlist karakter setiyle doğrular, dosya adında separator/control karakterlerini reddeder, root dışına çıkan canonical path'i engeller ve resolve sırasında directory/metadata/data symlink'lerini ayrı ayrı reddeder. Desteklenen media type ve toplam byte sınırı da ingest öncesi uygulanır.

## Corpus'a etkisi

Bu wiki türetilmiş ve Git ile sürümlenen içeriktir. `.runtime/`, local database, artifact, auth config ve gerçek kullanıcı attachment'ları source olarak ingest edilmez. Dış kaynak snapshot'ı alınmadan önce lisans ve hassas veri kontrolü yapılır.

## İlgili sayfalar

- [Sistem görünümü](system-overview.md)
- [Control-plane servisi](control-plane-service.md)
- [Event yaşam döngüsü](event-lifecycle.md)

## Kaynaklar

- `SRC-REPO-001` — mevcut path/scope implementasyonu
- `SRC-REPO-005` — ürün güvenlik değişmezleri
- `SRC-ADR-0005`, `SRC-ADR-0007`, `SRC-ADR-0009`, `SRC-ADR-0010`, `SRC-ADR-0011`
