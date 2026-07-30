# Proje Kapanış Planı — Self-Hosted v1.0

- Plan durumu: Kapatıldı
- Plan tarihi: 27 Temmuz 2026 (28 Tem 2026 revizyonları: WP37 eklendi; WP36 ve
  WP37 kabul edildi; WP38 base-path deployment eklendi, release WP39'a kaydı)
- Aktif iş paketi: Yok
- Yönetim kaydı: `docs/planning/work-package-management.md`
- Revize ettiği plan: `docs/planning/phase-6-open-source-and-managed-cloud-plan.md`

## 1. Karar ve gerekçe

Proje, açık kaynak ve self-hosted ürün odaklı olarak **v1.0 sürümüyle kapatılacaktır**.
Managed Cloud public beta hedefi (WP35) yönetici kararıyla retire edilmiştir.

Gerekçe:

- WP0–WP34 bağımsız kabul edilmiş, ürünün çekirdek değeri (kalıcı, cihazdan bağımsız
  agent workspace) open-source + self-hosted dağıtımla eksiksiz sunulabilir durumdadır.
- WP35 uygulaması teslim edilmiş (`36f41c2` `feat: launch the managed cloud public
beta` + `15ec71a` hardening) ancak bağımsız kabulü yapılmamıştır. Kabul kriterleri
  (design-partner cohort, incident/capacity tatbikatı, billing reconciliation, public
  beta rollout) kod tesliminden çok sürekli bir işletme taahhüdü gerektirir; proje
  kapanış hedefiyle bağdaşmaz.
- WP33 ve WP34 ile üretilen `cloud` profili, tenant runtime ve provider-auth katmanları
  repo'da kalır; contract testleri `pnpm verify` içinde çalışmaya devam eder. Retire
  edilen şey kod değil, SaaS **launch ve operasyon** taahhüdüdür.

## 2. Retire kayıtları

| Kalem                                   | Karar                                                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WP35 — Managed SaaS onboarding ve beta  | Retire edildi. Uygulama commit'leri (`36f41c2`, `15ec71a`) history'de kalır; bağımsız kabul denetimi yapılmayacak, WP35 kabul edilmemiş sayılır ve SaaS launch/operasyon gerçekleştirilmeyecektir. |
| WP30-E — Production go-live doğrulaması | Tanımlandığı kapsamıyla (managed cloud pentest/soak/cohort) retire edildi. Self-hosted için gerçek-ortam kanıtı WP36'da üretilir.                                                                  |
| WP33 gerçek Kata/Kubernetes + KMS smoke | Retire edildi (yalnız managed cloud üretim ortamını ilgilendirir).                                                                                                                                 |
| WP34 `wp34:provider-smoke` (cloud)      | Managed cloud bağlamında retire edildi. Self-hosted trusted runner'da gerçek provider koşusu WP36 golden senaryosuyla karşılanır.                                                                  |
| x86_64 gerçek-ortam koşusu              | Opsiyonel'e düşürüldü. v1.0 zorunlu gerçek-ortam kanıtı ARM64 Linux'ta WP36–WP38 boyunca tamamlandı; x86_64 topluluk geri bildirimine açıktır.                                                     |

Retire kararları geri alınabilir: ileride Managed Cloud'a dönülmek istenirse WP35 ve
WP30-E, Faz 6 planındaki tanımlarıyla yeniden aktive edilebilir. Bu plan onları siler
değil, kapanış kapsamının dışına alır.

## 3. Kapanış iş paketleri

Yönetim protokolü değişmez: tek aktif iş paketi, bağımsız kabul, WP başına tek commit.

### WP36 — Gerçek ortam doğrulama koşusu

> Revizyon (28 Tem 2026, kullanıcı kararı): zorunlu gerçek-ortam kanıt ortamı,
> fiilî işletim hedefiyle uyumlu olarak **ARM64 Linux** (Apple Silicon üzerinde
> Docker Desktop / temiz Ubuntu 24.04 container'ı, iç Docker daemon'ıyla) kabul
> edilmiştir. x86_64 gerçek-ortam koşusu zorunlu olmaktan çıkarılmış,
> "opsiyonel — topluluk geri bildirimine açık" statüsüne alınmıştır. Golden
> senaryo kurulu ARM64 hedefinde koşulur. Karar geri alınabilir.

#### Hedef

Self-hosted dağıtımı temiz bir gerçek Linux ortamında uçtan uca kurup
işleterek, önceki kabullerde `not-run` bırakılmış gerçek-ortam gate'lerini kapatmak.

#### Kapsam

- Temiz, desteklenen bir Linux hedefinde (revizyonla: ARM64) belgelenmiş tek komutla kurulum:
  `pnpm wp32:preflight`, `wp32:install-smoke`, `wp32:lifecycle`, `wp32:credential-scan`
  gate'lerinin gerçek ortamda koşulması.
- Kurulu hedefte `wp32:golden`: telefon/PWA'dan başlatılan task istemci kapalıyken
  sürer, dönüşte replay edilir; kullanıcının kendi provider credential'ı yalnız
  self-hosted secret store içinde kalır (WP34 self-hosted gerçek provider kanıtı
  bu koşudan sayılır).
- Upgrade → rollback → backup/restore döngüsünün gerçek ortamda en az bir tam koşusu
  (`wp32:lifecycle` kapsamında) ve conversation/attachment kaybı olmadığının teyidi.
- Node.js >= 24 üzerinde `pnpm verify` (engines alanıyla fiilî uyum kanıtı; önceki
  kabuller Node 22 üzerinde koşmuştu).
- Taşınabilirlik düzeltmesi: `title-process-runner` içindeki `cwd: '/private/tmp'`
  sabitinin platformdan bağımsız hale getirilmesi (Linux'ta symlink hilesi olmadan
  çalışmalı). Bu, WP36'nın tek kod değişikliğidir.
- Koşu sonuçlarının redakte edilmiş kanıt özetiyle raporlanması.

#### Kapsam dışı

- x86_64 gerçek-ortam koşusu (revizyonla opsiyonel; yapılırsa rapora eklenir, kabul şartı değildir).
- Managed cloud ortam kurulumu, Kata/Kubernetes, AWS KMS.
- Yeni özellik geliştirme.

#### Zorunlu kabul

- Dört `wp32:*` gate'i ve `wp32:golden` gerçek ortamda (ARM64 kabul ortamı) geçer; hiçbir zorunlu kontrol
  `not-run` kalmaz.
- Node >= 24'te `pnpm verify` geçer.
- `/private/tmp` bağımlılığı kalkar; Linux'ta symlink'siz yeşil koşu kanıtlanır.
- Credential, log/backup/rapor çıktılarına plaintext sızmaz (`wp32:credential-scan`
  runtime bulgusu 0).
- `pnpm verify` ve `pnpm release:public-preflight` teslimat commit'inde geçer.

#### Teslimat commit'i

`fix: validate self-hosted distribution on a real linux host`

### WP37 — Kullanıcı hesapları ve parola-türevli at-rest mahremiyet

Eklenme kaydı (28 Tem 2026, kullanıcı kararı): v1.0 öncesi son özellik iş paketi
olarak eklendi; v1.0 release ve kapanış WP38'e kaydı. Ayrıntılı uygulama
prompt'u ayrıca teslim edilmiştir (`wp37-uygulama-promptu.md`).

#### Hedef

Self-hosted dağıtıma kayıt/giriş, env-allowlist ile kullanıcı kapısı ve her
kullanıcının içeriğinin parolasından türetilen, diske yazılmayan anahtarla
şifrelenmesini eklemek: operatör dahil kimse, kullanıcının parolası (veya
kayıtta bir kez gösterilen recovery key'i) olmadan o kullanıcının konuşmalarını
diskten/DB'den/yedekten okuyamaz.

#### Kapsam

- `SELF_HOSTED_ALLOWED_USERS` allowlist'i; liste dışı kayıt fail-closed reddedilir.
- Kayıt/giriş/recovery API'leri (Argon2id) + web login sayfası; scope token
  claim'lerinden türetilir; sessionStorage token enjeksiyonu son kullanıcı
  akışından kalkar.
- Kullanıcı başına workspace bootstrap'i ve RLS izolasyonu.
- Parola-türevli user-KEK + recovery-key ikinci sargısı ile mevcut envelope
  şifreleme zincirinin sarılması; anahtarlar yalnız bellekte (lease + audit).
- `wp37:test` + `wp37:privacy` operatör-okuyamaz kanıt gate'leri.
- Tehdit modeli ve bilinen sınır (çalışır durumda bellek) belgelenir.

#### Kapsam dışı

- Uçtan-uca (istemci tarafı) şifreleme; runtime bellek koruması.
- OAuth/social login, e-posta akışları; operatör kurtarma anahtarı (bilinçli yok).

#### Zorunlu kabul

- Allowlist dışı kayıt reddedilir; kayıt→giriş→mesaj akışı PWA'dan parola ile
  çalışır; recovery akışı çalışır.
- `wp37:privacy` geçer: DB/dump/yedekte düz metin 0; parolasız erişim yok;
  restart sonrası parolayla erişim sürer; crypto-erase geri döndürülemez.
- `pnpm verify`, `wp32:test` ve wp32 sandbox gate'leri regresyonsuz;
  `release:public-preflight` ardışık iki koşuda ACCEPTED, evidence bayt-aynı.

#### Teslimat commit'i

`feat: add user accounts with passphrase-derived at-rest privacy`

### WP38 — Reverse-proxy altında base-path (subpath) deployment

Eklenme kaydı (28 Tem 2026, kullanıcı kararı): WP37'nin bağımsız kabulünden
sonra, v1.0 öncesi ikinci ve son özellik iş paketi olarak eklendi; v1.0
release ve kapanış WP39'a kaydı. Ayrıntılı uygulama prompt'u ayrıca teslim
edilmiştir (`wp38-uygulama-promptu.md`); mimari karar ADR-0038'dedir.

#### Hedef

Self-hosted kurulumun tek bir yapılandırma değeriyle
(`SELF_HOSTED_BASE_PATH=/workspace`) bir reverse proxy'nin alt-path'i altında
tam işlevle çalışabilmesi: PWA kurulumu, service worker/offline replay,
`/v1/realtime` akışı ve tüm API dahil. Boş base-path (kök) davranışı bire bir
korunur. Motivasyon: operatörün Host catch-all'lı nginx + path-prefix include
altyapısına (`location ^~ /workspace/`) montaj.

#### Kapsam

- `SELF_HOSTED_BASE_PATH` env + `install --base-path` bayrağı; normalizasyon
  ve preflight'ta fail-closed doğrulama; env kalıcılığı.
- Web: Vite `base` (build-arg), router `basepath`, `apiBaseUrl` ikamesi
  (origin + base), manifest relative üyeler, SW kayıt URL'i/scope'u ve
  `sw.js`'in scope-türevli precache listesi.
- Sunucu: self-hosted web SSR sunucusu ve Caddy route'ları base farkındalı;
  kök health endpoint'leri korunur, base altındaki karşılıkları eklenir; kök
  `/` isteği base'e redirect, diğer base dışı yollar 404 (ADR-0038 §5).
- `wp38:subpath` sandbox kanıt gate'i: operatör topolojisinin eşleniği dış
  proxy (Host catch-all + path-prefix, URI strip yok) arkasında kurulum;
  manifest/SW scope, kayıt→akış API, realtime akışı ve SW offline replay
  base altında kanıtlanır.
- Kurulum runbook'una nginx `location ^~` örnekli subpath bölümü
  (operatörün `*.location.conf` include düzenine birebir uyan örnek dahil).

#### Kapsam dışı

- Aynı origin'de birden fazla eşzamanlı base-path / çoklu instance.
- Path tabanlı çoklu-tenant yönlendirme; yeni özellik/uç nokta; WP37
  yüzeyinde değişiklik (login sayfası da base altında çalışır, o kadar).

#### Zorunlu kabul

- `wp38:subpath` sandbox'ta geçer; boş base-path ile `wp32:*` ve `wp37:*`
  gate'leri regresyonsuz.
- Gerçek kurulumda (operatörün nginx'i altında `/workspace/` benzeri prefix)
  telefon/PWA akışı uçtan uca çalışır ve redakte kanıtla raporlanır.
- `pnpm verify` geçer; `pnpm release:public-preflight` ardışık iki koşuda
  ACCEPTED ve evidence bayt-aynı.

#### Teslimat commit'i

`feat: support base-path deployment behind a reverse proxy`

### WP39 — v1.0 release ve proje kapanışı

#### Hedef

Repository'yi fiilen yayımlamak, v1.0.0 sürümünü etiketleyip doğrulanabilir release
artifact'iyle çıkarmak ve projeyi belgelenmiş biçimde kapatmak.

#### Kapsam

- Açık yönetici kararlarının kapatılması: repo'nun public yapılması ve ürün adındaki
  "Codex" marka riski (`docs/policies/brand-and-endorsement-policy.md` + publish
  checklist'teki zorunlu adım) — gerekirse yeniden adlandırma bu WP'de yapılır.
- `v1.0.0` tag'i, CHANGELOG/release notları, imzalı/checksum'lu release artifact'i ve
  WP31 public release checklist'inin uçtan uca uygulanması.
- README ve dokümantasyonda destek sınırının netleştirilmesi: self-hosted desteklenen
  dağıtımdır; `cloud` profili "kod tabanında mevcut, işletilen bir hizmet değil ve
  desteklenmiyor" beyanıyla işaretlenir.
- Planlama dokümanlarında kapanış kaydı: `work-package-management.md` belge durumu
  `Kapatıldı` yapılır; retire ve kabul kayıtları son haline getirilir.
- `kivancguckiran/perseverance` origin'ine push ve repository'nin doğrudan
  public canonical kaynak olarak yayımlanması; ayrı mirror kullanılmaz.

#### Kapsam dışı

- Yeni özellik, yeni provider, yeni dağıtım profili.
- Sürüm sonrası bakım taahhüdü tanımlamak (yalnız mevcut SECURITY.md/support kapsamı
  beyanı geçerlidir).

#### Zorunlu kabul

- `pnpm release:public-preflight` release commit'inde ardışık iki koşuda ACCEPTED ve
  evidence bayt-aynı.
- Tag, artifact checksum/imza ve provenance yayımlanan sürümle eşleşir.
- Marka kararı kayıt altında; publish checklist'in tüm maddeleri işaretli.
- Public repo temiz bir contributor checkout'unda belgelenen adımlarla build/test
  edilebilir.
- `pnpm verify` geçer.

#### Teslimat commit'i

`chore: release v1.0.0 and close the project`

## 4. Kapanış exit kriteri

Aşağıdaki exit kriterleri WP39 release transaction'ıyla karşılanmıştır:

- [x] WP36, WP37, WP38 ve WP39 bağımsız kabul edilmiştir.
- [x] Self-hosted ürün gerçek ARM64 Linux ortamında kurulmuş; lifecycle
      (upgrade/rollback/backup), mobil/PWA ve subpath senaryoları
      kanıtlanmıştır.
- [x] Repository public canonical kaynaktır; v1.0.0 doğrulanabilir
      artifact'iyle yayımlanmıştır.
- [x] Retire edilen kapsam (WP35, WP30-E, managed cloud launch) yönetim
      kaydında açık ve geri alınabilir biçimde belgelenmiştir.
- [x] `main`, origin ile senkrondur ve release commit'inde working tree
      temizdir.

Kapanış kaydı: 30 Temmuz 2026. Sürüm commit'i
`git rev-parse v1.0.0^{commit}`, release artifact checksum'ları ise yayımlanan
`SHA256SUMS` dosyasıyla doğrulanır.
