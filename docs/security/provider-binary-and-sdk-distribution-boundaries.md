# Provider binary ve SDK dağıtım sınırları

- Durum: Yürürlükte
- Tarih: 2026-07-23
- Kapsam: WP31 (ADR-0031)

Bu belge, repository'nin çağırdığı üçüncü taraf provider CLI/SDK'larının
lisans ve yeniden dağıtım sınırlarını tanımlar. Temel ilke: **bu repository
hiçbir provider binary'sini içermez veya yeniden dağıtmaz; kullanıcı ilgili
aracı kendi kurar ve sağlayıcının lisans/kullanım koşullarını kendisi kabul
eder.**

## Dağıtım modeli

- Repository'de vendor'lanmış (commit edilmiş) hiçbir provider binary'si,
  SDK arşivi veya model ağırlığı yoktur; `pnpm release:public-preflight`
  secret/hijyen taramasıyla birlikte bu sınırın korunmasına hizmet eder.
- Adapter'lar (`packages/provider-cli-adapters`) provider CLI'larını çalışma
  anında `PATH` üzerinden isimle çağırır (`claude`, `gemini`, `cursor-agent`)
  veya kullanıcının verdiği yol ile (`CURSOR_AGENT_BIN`). CLI kurulu değilse
  özellik fail-closed kapalı kalır.
- Release artifact'lerimiz (container image dahil) provider CLI'sı içermez;
  self-hosted kurulumda kullanıcı CLI'yı kendi ortamına kurar.

## Provider bazında sınırlar

### OpenAI Codex CLI (`@openai/codex`)

- npm devDependency olarak pinlidir (0.144.2) ve **kullanıcının kendi
  `pnpm install` koşusunda** npm registry'den gelir; repository paketi
  yeniden dağıtmaz.
- npm paketi Apache-2.0 lisanslıdır; lisans metni ve NOTICE yükümlülükleri
  pakete aittir ve kurulumla birlikte gelir.
- Codex hesabı, auth ve kullanım koşulları OpenAI ile kullanıcı arasındadır;
  `codex login` credential'ı kullanıcının makinesinde kalır (README ve
  ADR-0031). Subscription OAuth sınırları WP34 kapsamındadır
  (`docs/security/wp34-provider-subscription-auth-research.md`).

### Anthropic Claude CLI (`claude`)

- Repository'ye dahil değildir ve dağıtılamaz; Anthropic'in kendi ticari
  lisans/koşullarına tabidir. Kullanıcı CLI'yı Anthropic'in belgelenmiş
  kanalından kurar.
- Adapter yalnız kurulu binary'yi `PATH` üzerinden çağırır; credential
  toplama, cookie okuma veya başka istemcinin auth dosyasını kopyalama
  yapılmaz (Faz 6 ilkeleri).

### Google Gemini CLI (`gemini`)

- Repository'ye dahil değildir; kullanıcı kendi kurar. Gemini CLI'nın kendi
  lisansı ve Google API kullanım koşulları geçerlidir.
- Consumer subscription OAuth `unsupported` sabitlenmiştir; yalnız Gemini
  API/Vertex auth yolları planlanır (Faz 6 planı, WP34).

### Cursor CLI (`cursor-agent`)

- Repository'ye dahil değildir; Anysphere'in ticari koşullarına tabidir.
  Kullanıcı kurar, `CURSOR_AGENT_BIN` ile yol verebilir.

## Ortak kurallar

- Hiçbir provider'ın OAuth client kimliği, cookie'si veya credential cache'i
  kopyalanmaz veya yeniden kullanılmaz; yalnız provider'ın belgelenmiş
  auth akışları kullanılır (Faz 6 planı §3).
- Provider marka adları yalnız uyumluluğu tarif etmek için kullanılır;
  hiçbir sponsorluk/endorsement iması yoktur
  (`docs/policies/brand-and-endorsement-policy.md`).
- Bir provider'ın koşulları dağıtım sınırlarını değiştirirse bu belge ve
  ilgili adapter feature flag'leri birlikte güncellenir; belirsizlikte
  fail-closed davranılır.
