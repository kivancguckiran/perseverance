# Proje Kapanış Planı — Self-Hosted v1.0

- Plan durumu: Yürürlükte
- Plan tarihi: 27 Temmuz 2026
- Aktif iş paketi: WP36
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

| Kalem                                   | Karar                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| WP35 — Managed SaaS onboarding ve beta  | Retire edildi. Uygulama commit'leri (`36f41c2`, `15ec71a`) history'de kalır; bağımsız kabul denetimi yapılmayacak, WP35 kabul edilmemiş sayılır ve SaaS launch/operasyon gerçekleştirilmeyecektir. |
| WP30-E — Production go-live doğrulaması | Tanımlandığı kapsamıyla (managed cloud pentest/soak/cohort) retire edildi. Self-hosted için gerçek-ortam kanıtı WP36'da üretilir. |
| WP33 gerçek Kata/Kubernetes + KMS smoke | Retire edildi (yalnız managed cloud üretim ortamını ilgilendirir).                          |
| WP34 `wp34:provider-smoke` (cloud)      | Managed cloud bağlamında retire edildi. Self-hosted trusted runner'da gerçek provider koşusu WP36 golden senaryosuyla karşılanır. |
| ARM64 gerçek-ortam koşusu               | Opsiyonel'e düşürüldü. v1.0 için zorunlu gerçek-ortam kanıtı x86_64 VPS'tir; ARM64 desteği "build-time doğrulanmış, gerçek ortamda topluluk geri bildirimine açık" olarak belgelenir. |

Retire kararları geri alınabilir: ileride Managed Cloud'a dönülmek istenirse WP35 ve
WP30-E, Faz 6 planındaki tanımlarıyla yeniden aktive edilebilir. Bu plan onları siler
değil, kapanış kapsamının dışına alır.

## 3. Kapanış iş paketleri

Yönetim protokolü değişmez: tek aktif iş paketi, bağımsız kabul, WP başına tek commit.

### WP36 — Gerçek ortam doğrulama koşusu (VPS)

#### Hedef

Self-hosted dağıtımı temiz bir gerçek Linux x86_64 VPS üzerinde uçtan uca kurup
işleterek, önceki kabullerde `not-run` bırakılmış gerçek-ortam gate'lerini kapatmak.

#### Kapsam

- Temiz, desteklenen bir Linux x86_64 VPS'te belgelenmiş tek komutla kurulum:
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

- ARM64 gerçek-ortam koşusu (opsiyonel; yapılırsa rapora eklenir, kabul şartı değildir).
- Managed cloud ortam kurulumu, Kata/Kubernetes, AWS KMS.
- Yeni özellik geliştirme.

#### Zorunlu kabul

- Dört `wp32:*` gate'i ve `wp32:golden` gerçek VPS'te geçer; hiçbir zorunlu kontrol
  `not-run` kalmaz.
- Node >= 24'te `pnpm verify` geçer.
- `/private/tmp` bağımlılığı kalkar; Linux'ta symlink'siz yeşil koşu kanıtlanır.
- Credential, log/backup/rapor çıktılarına plaintext sızmaz (`wp32:credential-scan`
  runtime bulgusu 0).
- `pnpm verify` ve `pnpm release:public-preflight` teslimat commit'inde geçer.

#### Teslimat commit'i

`fix: validate self-hosted distribution on a real linux host`

### WP37 — v1.0 release ve proje kapanışı

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
- Origin'e push ve public mirror yayını.

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

Aşağıdakilerin tümü sağlandığında proje kapanmış sayılır:

- WP36 ve WP37 bağımsız kabul edilmiştir.
- Self-hosted ürün gerçek bir VPS'te kurulmuş, yaşam döngüsü (upgrade/rollback/backup)
  ve mobil/PWA golden senaryosu gerçek ortamda kanıtlanmıştır.
- Repository public'tir; v1.0.0 doğrulanabilir artifact'iyle yayımlanmıştır.
- Retire edilen kapsam (WP35, WP30-E, managed cloud launch) yönetim kaydında açık ve
  geri alınabilir biçimde belgelenmiştir.
- Ana dal origin ile senkrondur; working tree temizdir.
