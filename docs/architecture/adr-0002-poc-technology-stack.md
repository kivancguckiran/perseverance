# ADR-0002: Faz 0 PoC teknoloji yığını

- Durum: Kabul edildi
- Tarih: 2026-07-14
- Kapsam: Yalnız Faz 0 protokol kanıtı

## Değişiklik kaydı

- 2026-07-14: Web framework tercihi Next.js'ten TanStack Start'a değiştirildi. Control plane ve realtime sınırları korunmuştur.

## Bağlam

Faz 0'ın amacı üretim multi-tenancy altyapısı kurmak değil; gerçek ve pinli bir `codex app-server` ile handshake, event normalization, approval, replay ve thread resume davranışını en kısa yoldan kanıtlamaktır. Workspace Agent'ın üretim sürümü ileride Rust veya Go olabilir, fakat PoC sırasında birden fazla dil kullanmak protokol kanıtına doğrudan değer katmaz.

Yerel geliştirme ortamında Codex CLI `0.144.2`, Node.js 24, pnpm, Rust, Go ve Docker mevcuttur.

## Karar

PoC tek dil ağırlıklı bir pnpm/TypeScript monorepo olarak kurulacaktır:

```text
apps/
  web/                         TanStack Start responsive timeline
services/
  control-plane/               Fastify REST + WebSocket gateway
agents/
  workspace-agent/             Node.js/TypeScript app-server supervisor
packages/
  codex-protocol-generated/    Pinli Codex sürümünden üretilen tip ve şemalar
  domain-events/               Versioned normalize event sözleşmeleri
  codex-event-adapter/         Upstream Codex → platform event dönüşümü
tests/
  golden-sessions/             Kaydedilmiş JSONL protokol senaryoları
```

- Package manager: pnpm workspace.
- Dil/runtime: TypeScript ve Node.js 24.
- Web: TanStack Start, TanStack Router ve TanStack Query; Vite tabanlı build.
- Control plane: Fastify; REST ve client-facing WebSocket aynı PoC servisi içinde.
- Lokal event/session store: SQLite; persistence adapter arkasında.
- Workspace Agent ile app-server taşıması: varsayılan `stdio`/JSONL.
- Codex pin: başlangıçta yerelde doğrulanan `0.144.2`; generated schema ve checksum repository'de sürümlenir.
- Auth: app-server'ın resmî account/auth yüzeyi kullanılır. Credential platform event store'a veya repository'ye yazılmaz.
- PoC runtime: lokal process sınırı. Docker, production sandbox veya tenant izolasyonu Faz 0 exit kriterinden sonra ele alınır.

TanStack Start'ın server route ve server function yüzeyleri yalnız web uygulamasına özgü BFF ihtiyaçlarında kullanılabilir. Workspace yaşam döngüsü, durable event ingest, approval çözümleme ve uzun ömürlü realtime bağlantıları ayrı Fastify control plane servisinde kalır. Böylece web framework seçimi domain ve data-plane sınırlarına taşmaz.

## İlk dikey dilim

İlk çalışan teslimat şu zincirdir:

1. Workspace Agent app-server'ı başlatır.
2. `initialize` ve `initialized` el sıkışması tamamlanır.
3. `thread/start` ve `turn/start` gönderilir.
4. Raw JSONL mesajları güvenli biçimde kaydedilir.
5. Desteklenen mesajlar normalize event'e dönüşür.
6. Event'ler SQLite'a monotonic sequence ile eklenir.
7. Web timeline REST snapshot + WebSocket live stream ile güncellenir.
8. Browser reconnect son sequence üzerinden replay yapar.

## PoC başarı demosu

- Kullanıcı web istemcisinden bir repository görevi başlatır.
- Agent message, reasoning summary, plan, command output ve file diff canlı görünür.
- Command/file approval kullanıcıya bağlamıyla gösterilir ve yalnız bir kez çözümlenir.
- Browser kapalıyken turn devam eder.
- Browser yeniden açıldığında timeline eksiksiz replay edilir.
- Aynı Codex thread'i resume edilip yeni turn başlatılabilir.

## Faz 0 dışında

- Organization, RBAC ve gerçek multi-tenancy
- Billing ve usage reconciliation
- Corpus ve vector index
- Native mobil uygulama
- Kubernetes, mikro-VM ve production isolation
- Multi-region ve production disaster recovery

Bu kararlar PoC kodunun production-ready olduğu anlamına gelmez. Özellikle SQLite ve TypeScript Workspace Agent, doğrulama hızını artırmak için seçilmiştir ve sonraki ADR'lerle değiştirilebilir.
