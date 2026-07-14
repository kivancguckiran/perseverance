# Persistent Codex Workspace

Codex için çok kiracılı, kalıcı ve mobil öncelikli bir çalışma alanı platformu.

Bu repository'nin mimari doğruluk kaynağı [tasarım spesifikasyonudur](docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md). Ürünün çekirdeği terminal çıktısını ekran kazıyarak taklit etmez; her izole workspace içinde gerçek `codex app-server` çalıştırır ve sürüme bağlı olayları kararlı platform olaylarına normalize eder.

## İlk hedef

Faz 0 protokol kanıtı şu soruyu cevaplar:

> Pinli bir `codex app-server` sürümünden gelen mesaj, plan, reasoning summary, komut, çıktı, diff ve approval olaylarını kayıpsız normalize edip browser yeniden bağlandığında aynı thread'i sürdürebiliyor muyuz?

Ana uygulama planı [PoC uygulama planında](docs/planning/poc-implementation-plan.md), özet sıra ve güncel durum [PoC yol haritasında](docs/planning/poc-roadmap.md), app-server kararı [ADR-0001](docs/architecture/adr-0001-app-server-integration.md), PoC teknoloji yığını ise [ADR-0002](docs/architecture/adr-0002-poc-technology-stack.md) içinde tutulur.

İş paketlerinin tek-aktif-paket kuralı, teslimat denetimi ve uygulama task'larına verilecek prompt formatı [İş Paketi Yönetim Protokolünde](docs/planning/work-package-management.md) tanımlanır.

## Değişmezler

- App-server bağlantısı MVP'de yerel `stdio`/JSONL kullanır.
- Codex sürümü pinlenir; generated schema ve adapter birlikte sürümlenir.
- Ham kaynak olay ile normalize domain olayı ayrı tutulur.
- `item/completed` ve final snapshot'lar delta akışını reconcile eden doğruluk kaynağıdır.
- Approval kararları dayanıklı, idempotent ve optimistic locking ile korunur.
- Workspace dosya sistemi ve Git doğruluk kaynağıdır; indeksler türetilmiş veridir.
- Control plane tenant dosya sistemini doğrudan mount etmez.
- API anahtarları istemciye veya kalıcı loglara yazılmaz.

## Planlanan repository sınırları

```text
apps/                 web ve ileride mobil istemci
services/             control-plane servisleri
agents/               workspace-agent
packages/             protokol, domain ve güvenlik paketleri
infra/                image, runtime ve policy tanımları
tests/                contract, golden-session ve izolasyon testleri
docs/                 mimari, karar kayıtları ve planlama
```

Bu dizinler ihtiyaç doğdukça, Faz 0'ın dikey dilimini destekleyecek biçimde açılacaktır; başlangıçta dağıtık servis sayısı artırılmayacaktır.

## Yerel geliştirme

Gereksinimler: Node.js 24, pnpm 9.15.3 ve Codex CLI 0.144.2.

```bash
pnpm install
pnpm generate:codex-protocol
pnpm verify
pnpm dev
```

- Web: `http://localhost:3000`
- Control plane: `http://127.0.0.1:3100`
- Health: `http://127.0.0.1:3100/healthz`

Gerçek session → `thread/start` → `turn/start` → final agent message akışı, dosya değiştirmeyen kısa bir prompt ile opt-in çalıştırılabilir:

```bash
pnpm --filter @persistent-codex/workspace-agent smoke:real-flow
```

## WP4 API yüzeyi

- `POST /v1/sessions`: `x-tenant-id` ve `x-workspace-id` zorunludur; body `{}` olmalıdır. Cwd yalnız server-side `WORKSPACE_CWD` konfigürasyonundan gelir.
- `POST /v1/sessions/:sessionId/turns`: aynı scope header'ları ve `Idempotency-Key` zorunludur; body `{ "prompt": "..." }` şeklindedir.
- `GET /v1/sessions/:sessionId/events?after=&limit=`: durable replay.
- `GET /v1/realtime`: shared Zod `subscribe`, `replay`, `event` ve `ack` WebSocket sözleşmesi.

Runtime yaşam döngüsü ve idempotency kararı [ADR-0004](docs/architecture/adr-0004-live-thread-turn-orchestration.md) içinde açıklanır.
