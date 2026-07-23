# WP34 provider subscription authentication araştırma kararı

- Durum: Faz 6 plan girdisi; implementation veya provider onayı değildir
- Değerlendirme tarihi: 20 Temmuz 2026
- Kapsam: OpenAI Codex, Anthropic Claude ve Google Gemini subscription
  authentication'ın self-hosted ve Managed Cloud kullanımı
- Ayrıntılı kaynak raporu: 20 Temmuz 2026 tarihli harici WP34 araştırma teslimatı

## Yönetici kararı

Persistent Agent aşağıdaki güvenli varsayımlarla ilerler:

1. **Platform-managed API**, Managed Cloud'un varsayılan ve provider sözleşmelerinde
   açıkça ürün/end-user kullanımına yönelik modelidir.
2. **Customer API key**, self-hosted'da desteklenir. Managed Cloud'da tenant-scoped
   vault tasarlanır; fakat provider key-custody hükmü doğrulanmadan genel kullanıma
   açılmaz.
3. **Subscription OAuth**, self-hosted ve Managed Cloud için aynı yetki değildir.
   Kullanıcının kendi cihazı/private runner'ı için belgelenen akış, vendor'ın token
   tuttuğu hosted hizmete otomatik olarak genişletilmez.
4. Managed Cloud subscription auth bütün provider'larda default-off'tur. Provider
   bazında tarihli yazılı izin/uygulama kaydı olmadan flag açılamaz.
5. Başka bir provider istemcisinin OAuth client kimliği, cookie'si veya credential
   dosyası toplanmaz ya da Persistent Agent kimliğiyle yeniden kullanılmaz.
6. Full multi-tenant shared runtime hiçbir subscription credential kabul etmez.

## Doğrulanan provider sınırları

### OpenAI Codex / ChatGPT

- Codex, subscription erişimi için ChatGPT login'i ve usage-based erişim için API key
  login'ini destekler.
- Resmî auth dokümanı headless/private runner için device-code login, SSH callback
  forwarding ve `auth.json` kopyalama yöntemlerini belgeler.
- `auth.json` plaintext access token içerir ve parola gibi korunmalıdır.
- Resmî CI/CD rehberi API key'i otomasyon için doğru/varsayılan yol sayar;
  ChatGPT-managed `auth.json` akışını yalnız trusted private automation ve serialized
  tek runner/job stream için tarif eder. Generic OAuth client'ları bu rehberin dışında
  bırakır.
- ChatGPT Pro yardım metni hesap paylaşımını ve ChatGPT'nin third-party service'i
  çalıştırmak için kullanılmasını yasaklar. Bu nedenle vendor-managed subscription
  inference yazılı teyit olmadan desteklenmiş sayılmaz.

Resmî kaynaklar, erişim 20 Temmuz 2026:

- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex account auth in CI/CD](https://developers.openai.com/codex/auth/ci-cd-auth)
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/), yürürlük
  1 Ocak 2026
- [About ChatGPT Pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers),
  erişim sırasında sayfada “Updated: 6 days ago”

### Anthropic Claude

- Anthropic, Claude OAuth'u subscription müşterilerinin Claude Code ve native
  Anthropic uygulamalarındaki olağan kullanımı için tanımlar.
- Third-party geliştiricilerin Claude.ai login sunmasına veya Free/Pro/Max plan
  credential'larıyla kullanıcıları adına request yönlendirmesine izin verilmez.
- Agent SDK ürünü için varsayılan authentication API key veya desteklenen cloud
  provider'dır. Subscription login ancak “previously approved” ise kullanılabilir.
- Anthropic bu sınırları önceden bildirmeden uygulama hakkını saklı tutar; bu nedenle
  kill switch ve terms monitoring zorunludur.

Resmî kaynaklar, erişim 20 Temmuz 2026:

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

### Google Gemini

- 18 Haziran 2026 itibarıyla Gemini Code Assist for individuals ile Google AI Pro/Ultra
  katmanları Gemini CLI ve IDE extension request'lerini durdurmuş; consumer “Login with
  Google” seçeneği kaldırılmıştır. Standard/Enterprise etkilenmemiştir.
- Google'ın resmî Gemini CLI repository dokümanı, Gemini CLI'ı besleyen servislere
  OpenClaw gibi third-party software ile OAuth üzerinden doğrudan erişmeyi açıkça
  terms/policy ihlali ve hesap suspension/termination nedeni sayar.
- Bu nedenle Gemini subscription OAuth Persistent Agent'ta desteklenmez. Gemini için
  yalnız Gemini API veya Vertex AI tabanlı izinli API/cloud auth yolları planlanır.

Resmî kaynaklar, erişim 20 Temmuz 2026:

- [Gemini Code Assist consumer account deprecation](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals),
  son güncelleme 23 Haziran 2026
- [Gemini CLI license, terms and privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)
- [Gemini CLI authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.md)
- [Gemini API terms](https://ai.google.dev/gemini-api/terms)

## Başlangıç capability matrisi

Kararlar provider koşulları değiştikçe versioned evidence ile güncellenir.

| Provider/auth modu                 | Kullanıcı cihazı/VPS | Managed single tenant | Shared control + isolated runtime | Full shared runtime            |
| ---------------------------------- | -------------------- | --------------------- | --------------------------------- | ------------------------------ |
| Codex subscription, resmî CLI      | Supported            | Written approval      | Written approval                  | Unsupported                    |
| Codex customer API key             | Supported            | Custody confirmation  | Custody confirmation              | Tenant key olmadan unsupported |
| Codex platform-managed API         | Supported            | Supported             | Supported                         | Supported                      |
| Claude subscription/Agent SDK      | Prior approval       | Prior approval        | Prior approval                    | Unsupported                    |
| Claude customer API key            | Supported            | Custody confirmation  | Custody confirmation              | Tenant key olmadan unsupported |
| Claude platform-managed API/cloud  | Supported            | Supported             | Supported                         | Supported                      |
| Gemini consumer subscription OAuth | Unsupported          | Unsupported           | Unsupported                       | Unsupported                    |
| Gemini customer API key            | Supported            | Custody confirmation  | Custody confirmation              | Tenant key olmadan unsupported |
| Gemini platform-managed/Vertex     | Supported            | Supported             | Supported                         | Supported                      |

`Written approval`, `Prior approval` ve `Custody confirmation` durumları runtime'da
supported değildir; gerekli tarihli evidence kaydı sağlanana kadar fail-closed
davranır.

## WP34'e taşınan zorunlu kontroller

- Capability kararı `(provider, authMode, deploymentProfile, evidenceVersion)` ile
  versioned ve deny-by-default tutulur.
- Managed subscription flag'i, tarihli provider evidence URI/hash'i olmadan açılamaz.
- Gemini consumer subscription OAuth contract'ta `unsupported` olarak sabitlenir.
- Codex self-hosted login yalnız resmî Codex CLI device-code/PKCE ve trusted private
  runner sınırında çalışır; Persistent Agent generic OAuth client gibi davranmaz.
- Claude subscription modu provider approval kaydı olmadan self-hosted dahil açılmaz;
  API key/cloud provider yolu gösterilir.
- Provider/auth-mode kill switch yeni turn'leri durdurur, aktif işi güvenli terminal
  duruma taşır ve kullanıcıya alternatif auth yolu sunar.
- Token state/PKCE, expiry, serialized refresh, revoke, disconnect, crypto-erasure,
  cross-tenant substitution ve redaction testleri zorunludur.
- Subscription kullanım tutarı `estimated` ve fatura dışıdır. Provider API/platform
  reconciliation ayrı tutulur.
- Provider terms URL, observed update/effective date, evidence hash ve son kontrol
  zamanı operasyonel watch listesinde tutulur.

## Yazılı teyit gerektiren ana sorular

### OpenAI

- Kullanıcının kendi ChatGPT/Codex subscription'ını vendor-managed single-tenant
  instance'ta resmî Codex CLI ile kullanması third-party service yasağı kapsamında
  mıdır?
- Böyle bir ürün için third-party Sign in with ChatGPT registration/approval yolu
  var mıdır?
- Customer API key'in tenant-scoped encrypted vault'ta tutulması API key transfer
  yasağı kapsamında mıdır?

### Anthropic

- Agent SDK için “previously approved” statüsüne başvuru süreci ve deployment sınırı
  nedir?
- Team/Enterprise subscription credential'ları vendor-managed dedicated runtime'da
  kullanılabilir mi?
- Customer API key custody ayrıca resale/partnership onayı gerektirir mi?

### Google

- Antigravity veya Code Assist Standard/Enterprise için third-party agent integration
  programı var mıdır?
- Customer Gemini API key'in tenant-scoped encrypted vault'ta tutulması Google APIs
  Terms altında izinli midir?
- Vendor-managed dedicated instance'ta değiştirilmemiş resmî CLI kullanımının izin
  sınırı nedir?

Bu sorular yazılı yanıtlanmadan ilgili capability `supported` durumuna geçirilemez.
