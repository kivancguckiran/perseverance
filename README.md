# Perseverance

[![Lisans: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Codex, Claude, Gemini ve Cursor agent'ları için çok kiracılı, kalıcı ve mobil
öncelikli bir çalışma alanı platformu. Bağımsız bir community projesidir;
hiçbir model sağlayıcısıyla bağlantılı değildir ve onlar tarafından
desteklenmez (bkz. [NOTICE](NOTICE) ve
[marka politikası](docs/policies/brand-and-endorsement-policy.md)).

Bu repository'nin mimari doğruluk kaynağı [tasarım spesifikasyonudur](docs/architecture/perseverance-tasarim-spesifikasyonu.md). Ürünün çekirdeği terminal çıktısını ekran kazıyarak taklit etmez; her izole workspace içinde gerçek `codex app-server` çalıştırır ve sürüme bağlı olayları kararlı platform olaylarına normalize eder.

## Why this exists

Perseverance is a personal, purely vibe-coded project that I built for my
own daily use. I wanted a persistent workspace where agents can keep working,
retain context, surface approvals, and remain reachable when I am away from
the desktop.

Today, capable coding agents are still largely bound to their desktop apps.
Dispatch-style and mobile solutions are useful, but they do not yet give me
the same continuity, visibility, and ease of use as a durable workspace. This
project is my attempt to fill that gap.

Perseverance is free to use, including for personal use, under the
[GNU AGPL-3.0-only license](LICENSE). It is not restricted to personal use,
but there is no commercial hosted service, warranty, SLA, or promise that it
will fit anyone else's workflow. It is a self-hosted tool shared in the hope
that it may also be useful to others.

## Vibe-coded, command-accepted

The implementation was developed with coding agents, but work packages were
not accepted on an agent's claim that the work was complete. Development
progressed through explicit work packages up to WP39. Each package defined its
scope, architectural and security invariants, required commands, acceptance
criteria, evidence, and cleanup obligations.

The governing process is documented in the
[Work Package Management Protocol](docs/planning/work-package-management.md).
The final release and project closure are recorded in the
[WP39 delivery report](wp39-teslimat-raporu.md) and
[project closure plan](docs/planning/project-closure-plan.md).

Acceptance is command-driven and fail-closed. The main release gates include:

```bash
pnpm verify                       # format, types, tests, build, SSR smoke
pnpm release:public-preflight     # secrets, licenses, SBOM, clean checkout
pnpm wp29:reproducible-build      # reproducible application artifacts
pnpm wp29:sbom                    # artifact and image SBOMs
pnpm wp29:signatures              # cosign signatures and SLSA provenance
pnpm wp29:security-scans          # gitleaks, Semgrep, Trivy and policy gates
pnpm wp32:test                    # self-hosted distribution invariants
pnpm wp37:privacy                 # at-rest conversation privacy boundary
```

The `v1.0.0` release was also exercised from a clean public checkout and in a
real ARM64 Linux environment. Release artifacts carry checksums, cosign
signatures, provenance, a trust policy, and a source-commit manifest. The
[public release checklist](docs/operations/public-release-checklist.md)
describes the complete acceptance and publication path.

## v1.0 destek sınırı

**Desteklenen dağıtım modeli self-hosted kurulumdur.** `cloud` profili ve
managed-runtime kodu mimari geçmişi ve contract testleriyle birlikte kod
tabanında kalır; ancak işletilen bir Perseverance bulut hizmeti yoktur ve bu
profil desteklenmez. Ayrıntılar [SUPPORT.md](SUPPORT.md) ve
[proje kapanış planında](docs/planning/project-closure-plan.md) kayıtlıdır.

Self-hosted kurulum:

```bash
git clone https://github.com/kivancguckiran/perseverance.git
cd perseverance
bash infra/self-hosted/self-hosted.sh install \
  --domain workspace.example.com --acme-email admin@example.com
```

Gereksinimler, TLS seçenekleri, subpath kurulumu ve yaşam döngüsü işlemleri
[self-hosted kurulum runbook'unda](docs/operations/self-hosted-install-runbook.md)
belgelenir.

## Mimari temel

Faz 0 protokol kanıtı şu soruyu cevaplar:

> Pinli bir `codex app-server` sürümünden gelen mesaj, plan, reasoning summary, komut, çıktı, diff ve approval olaylarını kayıpsız normalize edip browser yeniden bağlandığında aynı thread'i sürdürebiliyor muyuz?

Faz 0 planı [PoC uygulama planında](docs/planning/poc-implementation-plan.md), Faz 1
iş paketleri [tek kiracılı alfa planında](docs/planning/phase-1-alpha-plan.md), özet sıra ve
tarihsel durum [PoC yol haritasında](docs/planning/poc-roadmap.md), app-server kararı
[ADR-0001](docs/architecture/adr-0001-app-server-integration.md), teknoloji yığını ise
[ADR-0002](docs/architecture/adr-0002-poc-technology-stack.md) içinde tutulur.

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

## Kurulum ve yerel geliştirme

Gereksinimler: Node.js 24, pnpm 9.15.3 (corepack) ve Codex CLI 0.144.2.
Temiz checkout'tan build/test adımlarının tamamı
[CONTRIBUTING.md](CONTRIBUTING.md) içindedir:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm alpha:dev
```

`pnpm alpha:dev` lokal alfa için tek desteklenen başlangıç komutudur. Kalıcı runtime
yollarını `.runtime/alpha` altında oluşturur ve web ile control-plane'i birlikte
başlatır. `CODEX_PROVISIONING_SOURCE` verilirse yalnız o kaynak kullanılır; verilmezse
yalnız bu lokal komut `CODEX_HOME`, ardından `~/.codex` varsayılanını dener. Kalıcı
home'a yalnız `auth.json` ve `config.toml` read-only symlink edilir; session, history,
log ve plugin state'i bağlanmaz. Production başlangıcında örtülü host credential
erişimi yoktur.

Auth hazır değilse `/readyz` `setup_required` ve `codex login` yönergesi döndürür;
session/turn upstream'e gönderilmez. `/healthz` yalnız liveness'tır. Ayrıntılı recovery
için [alfa auth troubleshooting rehberine](docs/operations/alpha-auth-troubleshooting.md)
bakın.

Tamamlanan Faz 0'ın üç gerçek golden görevi ve dört arıza senaryosunu redakte kanıtla
çalıştıran birleşik smoke komutları şunlardır:

```bash
pnpm demo:smoke
pnpm demo:golden:read-only
pnpm demo:golden:change
pnpm demo:golden:approval
```

Temiz kurulum, browser adımları, beklenen semantik timeline kartları, cleanup ve sorun
giderme için [PoC demo rehberine](docs/demo/poc-demo.md) bakın.

- Web: `http://localhost:3000`
- Control plane: `http://127.0.0.1:3100`
- Health: `http://127.0.0.1:3100/healthz`
- Readiness: `http://127.0.0.1:3100/readyz` (scope header'ları zorunlu)

Gerçek session → `thread/start` → `turn/start` → final agent message akışı, dosya değiştirmeyen kısa bir prompt ile opt-in çalıştırılabilir:

```bash
pnpm --filter @perseverance/workspace-agent smoke:real-flow
```

Gerçek smoke komutları geçici `perseverance-smoke-*` `CODEX_HOME` dizini kullanır. Yalnız mevcut `auth.json` ve `config.toml` dosyalarına symlink açılır; normal Codex task/session/state verileri bağlanmaz. Child process kapatıldıktan sonra geçici dizin silinir. Bu smoke komutları `pnpm verify` içinde otomatik çalışmaz ve yalnız açıkça çağrıldığında çalışır.

Durable approval smoke'u control-plane REST session/turn/GET pending/decision akışını, ölçülen upstream response sayısını ve geçici SQLite cleanup'ını birlikte doğrular:

```bash
pnpm --filter @perseverance/workspace-agent smoke:real-approval
```

## WP4 API yüzeyi

- `POST /v1/sessions`: `x-tenant-id` ve `x-workspace-id` zorunludur; body `{}` olmalıdır. Cwd yalnız server-side `WORKSPACE_CWD` konfigürasyonundan gelir.
- `POST /v1/sessions/:sessionId/turns`: aynı scope header'ları ve `Idempotency-Key` zorunludur; body `{ "prompt": "..." }` şeklindedir.
- `GET /v1/sessions/:sessionId/events?after=&limit=`: durable replay.
- `GET /v1/realtime`: shared Zod `subscribe`, `replay`, `event` ve `ack` WebSocket sözleşmesi.

Runtime yaşam döngüsü ve idempotency kararı [ADR-0004](docs/architecture/adr-0004-live-thread-turn-orchestration.md) içinde açıklanır.

## WP6 resume yüzeyi

Control plane, `CODEX_HOME_ROOT` altında tenant/workspace kimliklerinin hash’iyle ayrılmış, canonical ve `0700` persistent home’lar kullanır. Browser bu path’i gönderemez. Session URL’si `/sessions/:sessionId` biçimindedir.

- `GET /v1/sessions/:sessionId`: durable recovery durumu, runtime bağlılığı ve replay high-water.
- `POST /v1/sessions/:sessionId/resume`: `Idempotency-Key` ile `thread/read` → `thread/resume`.
- `POST /v1/sessions/:sessionId/turns/:turnId/steer`: zorunlu `expectedTurnId` ve `prompt`.
- `POST /v1/sessions/:sessionId/turns/:turnId/interrupt`: idempotent durdurma.

Resume başarısızlığı thread’i değiştirmez; `THREAD_NOT_RESUMABLE` ve recovery seçenekleri durable session detail’de görünür. Kararlar [ADR-0006](docs/architecture/adr-0006-session-resume-recovery.md) içinde açıklanır.

İki control-plane instance’ı, aynı SQLite ve persistent home ile gerçek `thread/read`/`thread/resume` akışını opt-in doğrulamak için:

```bash
pnpm --filter @perseverance/workspace-agent smoke:real-recovery
```

## Mahremiyet tehdit modeli ve bilinen sınırlar (WP37)

Self-hosted kurulumda her kullanıcının konuşma içeriği (prompt ve model
çıktısı), parolasından türetilen ve sunucu diskine asla yazılmayan bir
anahtarla şifrelenir (ADR-0037). Garanti **at-rest** içindir: makinede root
erişimi olan operatör dahil hiç kimse, kullanıcının parolası (veya kayıtta bir
kez gösterilen recovery key'i) olmadan o kullanıcının konuşma geçmişini
diskten, veritabanından, `pg_dump` çıktısından veya yedekten okuyamaz; kanıt
gate'i `pnpm wp37:privacy`'dir. Bilinen ve bilinçli sınırlar:

- Sistem çalışırken düz metin ve anahtarlar bellekte işlenir; runtime bellek
  erişimine, iç ağ trafiğini dinleyen root'a veya ürün kodunu kötü niyetle
  değiştiren operatöre karşı garanti verilmez.
- Workspace çalışma dizini (agent'ın ürettiği dosyalar) şifreleme kapsamı
  dışındadır; kapsam konuşma içeriğidir.
- Parola ve recovery key birlikte kaybolursa veri kurtarılamaz; operatör
  kurtarma anahtarı bilinçli olarak yoktur ve hesap yalnız crypto-erase ile
  sıfırlanabilir.

## Lisans, güvenlik ve destek

Bu repository **GNU AGPL-3.0-only** lisanslıdır; karar ve gerekçeler
[ADR-0031](docs/architecture/adr-0031-open-source-license.md) içindedir.
Telif beyanı [NOTICE](NOTICE) dosyasındadır. Provider CLI/SDK'ları
repository'ye dahil değildir; sınırlar
[provider dağıtım belgesinde](docs/security/provider-binary-and-sdk-distribution-boundaries.md)
tanımlanır.

- Güvenlik açığı bildirimi: [SECURITY.md](SECURITY.md) (public issue açmayın).
- Destek kapsamı: [SUPPORT.md](SUPPORT.md) — self-hosted community sürümü
  best-effort desteklidir ve SLA yoktur; managed cloud işletilmez.
- Katkı süreci ve DCO: [CONTRIBUTING.md](CONTRIBUTING.md),
  davranış kuralları: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Public release süreci: [public release checklist](docs/operations/public-release-checklist.md)
  ve `pnpm release:public-preflight` gate'i (secret taraması, lisans gate'i,
  SBOM, temiz checkout doğrulaması).
