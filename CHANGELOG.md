# Changelog

Bu proje [Semantic Versioning](https://semver.org/) kullanır.

## [1.0.0] — 2026-07-30

Perseverance'ın ilk public ve desteklenen self-hosted sürümü.

### Ürün

- Gerçek ve pinli `codex app-server` üzerinde durable thread/turn, replay,
  reconnect, approval, steer/interrupt ve büyük çıktı/artifact akışları.
- Codex, Claude, Gemini ve Cursor için provider-neutral conversation,
  kullanım ledger'ı, PWA, mobil approval/push ve çoklu cihaz sürekliliği.
- Tenant/RLS izolasyonu, envelope encryption, audit/metrics, corpus ingestion,
  hybrid retrieval ve workspace-local MCP.
- Kullanıcı kayıt/giriş allowlist'i ile parola-türevli at-rest konuşma
  mahremiyeti ve tek kullanımlık recovery key akışı.

### Self-hosted dağıtım

- Digest-pinli Docker Compose topolojisi, TLS reverse proxy, migration,
  admin bootstrap, şifreli backup/restore, upgrade/rollback ve export'lu
  uninstall.
- Linux/amd64 ve Linux/arm64 release artifact'leri; checksum, cosign imzası,
  CycloneDX SBOM ve SLSA/in-toto provenance doğrulaması.
- Reverse proxy altında configurable base path; PWA/service worker, API,
  realtime ve offline replay subpath-aware çalışır.
- ARM64 Linux gerçek ortamında kurulum, lifecycle, credential scan, privacy
  ve base-path kabul gate'leri tamamlandı.

### Güvenlik ve yönetişim

- AGPL-3.0-only lisans, DCO katkı modeli, özel vulnerability bildirim kanalı,
  deterministik public preflight ve tam Git history secret taraması.
- `fast-uri` ve `find-my-way` transitive bağımlılıkları, release günündeki
  yüksek önem dereceli advisory'lerin patched sürümlerine sabitlendi.
- Önceki çalışma adı kaldırıldı; ürün, paketler, imajlar ve UI
  **Perseverance** adı altında birleştirildi.
- Destek sınırı self-hosted community dağıtımıdır. `cloud` profili kod
  tabanında korunur ancak işletilen veya desteklenen bir hizmet değildir.

[1.0.0]: https://github.com/kivancguckiran/perseverance/releases/tag/v1.0.0
