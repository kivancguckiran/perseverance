# Faz 6 — Open Source ve Managed Cloud planı

- Plan durumu: Yürürlükte
- Plan tarihi: 20 Temmuz 2026 (güncelleme: 25 Temmuz 2026, WP35 aktivasyonu)
- Aktif iş paketi: WP35; WP31–WP34 bağımsız kabul edildi
- Ön koşul: WP0–WP30 ve Faz 5 tamamlanmış olmalıdır
- Kaynak spesifikasyon:
  `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`
- Provider auth araştırma kararı:
  `docs/security/wp34-provider-subscription-auth-research.md`

## 1. Amaç

Persistent Codex Workspace'i iki tamamlayıcı dağıtım modeliyle yayımlamak:

1. Kendi makinesi veya VPS'i olan kullanıcı için açık kaynak, tek komutla kurulabilen
   ve kullanıcının kendi provider hesabını kendi altyapısında kullanan self-hosted ürün.
2. Sunucu işletmek istemeyen kullanıcı için tenant-isolated, sürekli çalışan, PWA ile
   erişilen ve operasyonu ürün tarafından yönetilen Managed Cloud.

İki dağıtım aynı contract, UI, event modeli ve agent adapter'larını kullanır. Cloud
özellikleri ayrı bir ürün fork'u oluşturmaz; deployment profile, entitlement ve
production adapter'larıyla ayrılır.

## 2. İş paketi özeti

| Paket | Faz | Durum      | Hedef                                                                |
| ----- | --- | ---------- | -------------------------------------------------------------------- |
| WP31  | 6   | Tamamlandı | Açık kaynak lisans, repository güvenliği ve public-release hazırlığı |
| WP32  | 6   | Tamamlandı | Tek komutlu, güncellenebilir ve yedeklenebilir self-hosted dağıtım   |
| WP33  | 6   | Tamamlandı | Community/Cloud edition sınırı ve tenant-isolated managed runtime    |
| WP34  | 6   | Tamamlandı | Provider auth profilleri, subscription OAuth ve credential lifecycle |
| WP35  | 6   | Aktif      | Managed SaaS onboarding, billing, operasyon ve kontrollü public beta |

Her zaman yalnız bir iş paketi aktif olabilir. WP30 ve Faz 5 bağımsız kabul edilmeden
WP31 aktive edilmez. WP31–WP35 sırayla uygulanır ve her paket bağımsız kabul edilmeden
sonraki paket başlatılmaz.

## 3. Ürün ve dağıtım ilkeleri

- `local`, `self-hosted` ve `cloud` deployment profilleri aynı kod tabanından üretilir.
- Self-hosted kullanıcı credential'ı kullanıcının makinesi/VPS'i dışına çıkmaz.
- Managed Cloud'da tenant credential'ı başka tenant, support süreci, log, trace,
  fixture, backup veya event store tarafından görülemez.
- Provider subscription erişimi yalnız provider'ın belgelenmiş OAuth/device flow'u
  ve gerekli third-party uygulama kaydı/onayıyla açılır. Başka istemcinin OAuth client
  kimliği izinsiz kopyalanmaz.
- Hesap, credential, kota veya rate limit tenant'lar arasında havuzlanmaz.
- Subscription kullanımı, customer API billing'i ve platform-managed kredi birbirinden
  ayrı auth/billing modlarıdır.
- Control plane kullanıcı kodu veya agent runtime'ını kendi process'i içinde çalıştırmaz.
- Managed Cloud workspace runtime'ları tenant-isolated filesystem, secret, network ve
  kapasite sınırlarıyla çalışır.

## 4. İş paketleri

### WP31 — Open-source hazırlığı, lisans ve repository güvenliği

#### Hedef

Repository'yi secret, lisans, marka ve supply-chain sınırları belirlenmiş biçimde halka
açılmaya hazır hale getirmek.

#### Kapsam

- AGPLv3, Apache-2.0 ve gerekiyorsa dual-license seçeneklerini değerlendiren ADR;
  seçimin community katkısı, hosted rakipler ve ticari lisans etkileri.
- Kod ve Git history secret taraması; credential, fixture, log ve örnek config temizliği.
- Direct/transitive dependency lisans envanteri, incompatibility gate'i ve SBOM.
- `LICENSE`, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, davranış kuralları, support ve
  vulnerability disclosure politikası.
- OpenAI Codex, Claude, Gemini ve diğer dağıtılan/çağrılan binary veya SDK'ların lisans
  ve yeniden dağıtım sınırları.
- Community adı/markası ile Managed Cloud markası ve endorsement beyanlarının ayrımı.
- İmzalı release artifact'i, provenance ve public release checklist'i.

#### Kapsam dışı

- Self-hosted production kurulumu ve cloud tenant provisioning.
- Provider OAuth implementasyonu.
- Public beta veya ücret tahsilatı.

#### Zorunlu kabul

- Public mirror'a gönderilecek kaynak ve history secret taramasından geçer.
- Dependency lisans raporu ve SBOM deterministik üretilir; yasak lisans gate'i çalışır.
- Temiz contributor checkout'unda build/test dokümantasyonu uygulanabilir.
- Güvenlik bildirimi, destek kapsamı ve marka/endorsement sınırı açıktır.
- `pnpm verify` ve public-release preflight geçer.

#### Teslimat commit'i

`chore: prepare the repository for open source release`

### WP32 — Tek komutlu self-hosted dağıtım

#### Hedef

Kullanıcının kendi VPS'i veya makinesinde kurup güncelleyebileceği, verisini ve provider
credential'ını kendi kontrolünde tutan desteklenebilir self-hosted ürün üretmek.

#### Kapsam

- Uygulama, PostgreSQL, object storage, reverse proxy ve gerekli worker'ları içeren
  version-pinned Docker Compose profili.
- Interactive olmayan install/preflight; domain, HTTPS, storage, ports, CPU/memory ve
  provider auth readiness kontrolü.
- x86_64 ve ARM64 image/release; checksum, signature ve provenance doğrulaması.
- Setup wizard, admin bootstrap, health/readiness ve güvenli default config.
- Upgrade, migration, rollback, backup/restore ve uninstall-with-export prosedürleri.
- Codex subscription login/device auth ve API credential kullanımının yalnız
  self-hosted secret store/runtime içinde kalması.
- PWA kurulumu, detached task, restart/replay ve mobil reconnect golden senaryosu.

#### Kapsam dışı

- Multi-tenant SaaS control plane.
- Platform-managed model kredisi ve SaaS tahsilatı.
- Kullanıcı VPS'ine izinsiz otomatik erişim veya zorunlu telemetry.

#### Zorunlu kabul

- Temiz desteklenen Linux VPS'te belgelenmiş tek komutla kurulum tamamlanır.
- Telefon/PWA'dan başlatılan task istemci kapalıyken sürer ve dönüşte replay edilir.
- Restart, upgrade, rollback ve backup/restore conversation/attachment kaybetmez.
- Codex device auth credential'ı host dışına, loga veya backup'a plaintext çıkmaz.
- ARM64 ve x86_64 smoke, install/uninstall cleanup ve `pnpm verify` geçer.

#### Teslimat commit'i

`feat: add production-ready self-hosted distribution`

### WP33 — Community/Cloud edition sınırı ve managed tenant runtime

#### Hedef

Community ve Managed Cloud'u aynı ürün contract'ları üzerinde tutarken cloud
workspace'lerini tenant-isolated, sürekli ve operasyonel olarak yönetilebilir hale
getirmek.

#### Kapsam

- `local`, `self-hosted`, `cloud` deployment profile contract'ı ve ADR.
- Entitlement/edition policy; core agent, conversation ve event semantiğinin fork
  edilmesini engelleyen contract testleri.
- Tenant/workspace provisioning, suspend/resume/delete ve idempotent reconciliation.
- Tenant'a özel runtime identity, filesystem/volume, encryption key, secret namespace,
  network policy, placement ve capacity reservation.
- Control plane ile runtime data plane arasında authenticated internal contract.
- Runtime recreation sonrası detached task/replay; orphan detection ve bounded cleanup.
- Tenant bazlı domain, region, retention ve kapasite metadata'sı.

#### Kapsam dışı

- Provider-specific OAuth ekranları.
- Nihai fiyatlandırma, ödeme ve public beta.
- Tenant'lar arasında paylaşılan provider credential veya runtime filesystem.

#### Zorunlu kabul

- İki gerçek tenant eşzamanlı çalışırken secret, event, artifact, filesystem ve network
  sınırları adversarial testlerden geçer.
- Runtime silme/yeniden oluşturma durable conversation ve completed output'u korur.
- Tenant A yükü Tenant B'nin belgelenmiş kapasite/SLO bütçesini aşındıramaz.
- Cloud profile local filesystem/in-memory production fallback'lerinde fail-closed olur.
- Provision/suspend/delete/reconcile, chaos ve `pnpm verify` kapıları geçer.

#### Teslimat commit'i

`feat: add tenant-isolated managed cloud runtime`

### WP34 — Provider account bağlantıları ve subscription OAuth

#### Hedef

Codex, Claude, Gemini ve sonraki provider'ları güvenli, iptal edilebilir ve maliyet
semantiği açık ortak bir auth profile contract'ı arkasına almak.

#### Kapsam

- Auth modları: `subscription-oauth`, `customer-api-key`, `platform-credit` ve
  `local-cli-credential`.
- Provider capability/terms matrisi; desteklenmeyen auth modu fail-closed ve feature
  flag arkasında kalır.
- Capability kararı `(provider, authMode, deploymentProfile, evidenceVersion)` ile
  versioned ve deny-by-default tutulur.
- Codex için provider tarafından belgelenmiş Sign in with ChatGPT OAuth/PKCE veya
  device-code akışı. Self-hosted kullanım trusted private runner ile sınırlıdır;
  Managed Cloud için yazılı third-party application registration/approval kanıtı
  zorunludur.
- Claude subscription modu provider'ın “previously approved” kaydı olmadan self-hosted
  dahil açılmaz; varsayılan yol API key veya desteklenen cloud provider'dır.
- Gemini consumer subscription OAuth contract'ta `unsupported` olarak sabitlenir;
  yalnız Gemini API/Vertex auth yolları sağlanır.
- Provider koşulu değişikliğinde provider/auth-mode specific kill switch.
- Tenant-scoped encrypted credential vault, KMS envelope, refresh lock, rotation,
  revoke, disconnect ve crypto-erasure.
- Credential'ın yalnız hedef tenant runtime'ına kısa ömürlü verilmesi; UI/support'ta
  credential erişiminin olmaması.
- Subscription quota/limit görünümü, customer API kullanım maliyeti ve platform kredi
  maliyetinin ayrı muhasebesi. Tahmini değerler açıkça `estimated` işaretlenir.

#### Kapsam dışı

- Hesap paylaşımı, credential pooling veya rate-limit bypass.
- Kullanıcı şifresi, browser cookie'si ya da başka istemcinin auth dosyasını toplama.
- Resmî kayıt/onay olmadan başka OAuth client kimliğini yeniden kullanma.
- Generic OAuth client gibi davranarak resmî Codex/Claude/Gemini istemci kimliğini,
  cookie'sini veya credential cache'ini kullanıcı cihazından toplama.

#### Zorunlu kabul

- OAuth state/PKCE, callback/device-code, expiry, concurrent refresh ve revoke testleri
  geçer.
- Managed subscription flag'i tarihli provider evidence URI/hash'i olmadan açılamaz;
  eksik evidence actionable configuration error ve fail-closed sonuç üretir.
- Token ve secret hiçbir log, event, trace, fixture, snapshot, backup veya support
  export'unda görünmez.
- Cross-tenant credential substitution ve stale/revoked token fail-closed olur.
- Provider koşulu/capability kapatıldığında yeni işler güvenli biçimde durur; mevcut
  kayıtlar silinebilir veya alternatif auth moduna geçirilebilir.
- Provider contract, gerçek izinli smoke ve `pnpm verify` geçer; çalışmayan gerçek
  credential kontrolleri açıkça `not-run` raporlanır.
- Provider terms watch listesi URL, observed update/effective date, evidence hash ve
  son kontrol zamanını taşır; en az bir terms-değişikliği/kill-switch tatbikatı geçer.

#### Teslimat commit'i

`feat: add secure provider account connections`

### WP35 — Managed SaaS onboarding, billing ve public beta

#### Hedef

Altyapı işletmek istemeyen kullanıcının kayıt olup provider bağlayarak telefondan
kalıcı agent task'ı çalıştırabildiği, ücret ve operasyon sınırları açık Managed Cloud
ürününü kontrollü public beta'ya çıkarmak.

#### Kapsam

- Signup/signin, tenant ve workspace onboarding, provider bağlama ve ilk task akışı.
- Plan, entitlement, compute/storage kotası, bütçe limiti ve usage görünümü.
- Hosting/compute/storage ile model kullanımını ayrı gösteren fiyatlandırma ve fatura.
- Platform-credit için reservation/settlement/refund; subscription kullanımında
  provider limit görünümü; başarısız/durdurulan task maliyeti.
- Custom domain/HTTPS, e-posta ve push bildirimleri, PWA install ve mobile resume.
- Privacy, Terms, subprocessors, retention, export/delete ve support/escalation akışı.
- Internal -> design partner -> limited public beta rollout; feature flag, capacity
  ceiling, abuse/rate control, kill switch, halt ve rollback.
- SLO/error budget, on-call, incident, billing reconciliation ve beta exit raporu.

#### Kapsam dışı

- Sınırsız genel erişim veya kontrolsüz otomatik ölçekleme.
- Provider tarafından izin verilmeyen subscription credential modu.
- Model kullanımını hosting ücretinin içinde gizleme veya tahmini maliyeti kesin fatura
  verisi gibi sunma.

#### Zorunlu kabul

- Yeni kullanıcı telefondan kayıt olur, workspace açar, izinli provider'ı bağlar ve
  task başlatır; uygulama kapalıyken task sürer ve dönüşte çıktı görünür.
- Kota, budget halt, failed/interrupted kullanım ve billing settlement doğrudur.
- Tenant export/delete ve credential revoke/crypto-erasure uçtan uca çalışır.
- Design-partner cohort üzerinde incident, capacity halt ve rollback tatbikatı geçer.
- Kritik/yüksek security veya privacy bulgusu açık kalmaz.
- Managed-cloud acceptance, browser/mobile golden, cleanup ve `pnpm verify` geçer.

#### Teslimat commit'i

`feat: launch the managed cloud public beta`

## 5. Faz 6 exit kriteri

- Repository güvenle halka açılmış ve doğrulanabilir release artifact'i yayımlanmıştır.
- Kullanıcı desteklenen bir VPS'e self-hosted ürünü kurabilir, güncelleyebilir,
  yedekleyebilir ve geri yükleyebilir.
- Managed Cloud tenant'ları runtime, data, secret ve kapasite açısından izoledir.
- Provider bağlantıları yalnız belgelenmiş ve izinli auth yollarını kullanır; revoke ve
  crypto-erasure çalışır.
- Kullanıcı mobil/PWA üzerinden task başlatıp uygulamayı kapattıktan sonra tamamlanmış
  çıktıyı görebilir.
- Hosting ve model maliyetleri ayrıştırılmış; quota, budget ve billing reconciliation
  üretim kanıtlarıyla doğrulanmıştır.
- Kontrollü public beta rollback, incident ve tenant lifecycle tatbikatlarını geçmiştir.

## 6. Faz geçiş ve kabul kuralları

- Her paketin uygulama commit'i ayrıdır; bağımsız kabul tamamlanmadan sonraki paket
  aktive edilmez.
- Open-source veya OAuth sağlayıcısının beyanı tek başına yeterli değildir; lisans,
  uygulama kaydı, gerçek auth flow ve güncel koşul kanıtı birlikte değerlendirilir.
- Self-hosted smoke sonucu Managed Cloud tenant izolasyonu kanıtı sayılmaz.
- Managed Cloud emulator sonucu gerçek provider OAuth, billing veya production
  isolation kanıtı sayılmaz.
- Secret içeren gerçek smoke çıktıları redakte edilir ve credential hiçbir kabul
  artifact'ine yazılmaz.
- WP35 bağımsız kabul edilmeden Faz 6 kapanmaz.
