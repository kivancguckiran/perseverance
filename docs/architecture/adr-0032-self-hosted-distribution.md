# ADR-0032 — Tek komutlu self-hosted dağıtım

- Durum: Kabul edildi
- Tarih: 2026-07-23
- Kapsam: WP32

## Bağlam

WP31 ile kod tabanı open-source yayına hazırlandı (ADR-0031). Faz 6 planı WP32'de,
kullanıcının kendi VPS'inde veya makinesinde tek belgelenmiş komutla kurulabilen,
güncellenebilen, yedeklenip geri yüklenebilen ve provider credential'ını host dışına
çıkarmayan desteklenebilir bir self-hosted ürün istiyor. `local`, `self-hosted` ve
`cloud` profilleri aynı kod tabanından üretilmek zorunda; bu paket ürün fork'u
oluşturmaz.

Mevcut durum:

- `infra/wp30-local/` altında production-like bir compose laboratuvarı var
  (postgres + minio + rabbitmq + oidc-stub + control-plane + workspace-agent + web),
  ancak loopback'e bağlı, TLS'siz, tek seferlik initdb migration'lı ve
  operatör-lab sınıfı (`WP30_EVIDENCE_CLASS=local-operator`).
- Reverse proxy ve TLS katmanı repo'da hiç yok.
- Migration'lar `infra/postgres/migrations/*.sql` dosyaları; uygulama içi runner yok,
  tracking tablosu yok (initdb yalnız boş volume'da bir kez koşuyor).
- İlk admin hesabı için self-servis akış yok; production control-plane her isteği
  `persistent_codex.organization_memberships` üzerinden yetkilendiriyor.
- Web istemcisi `VITE_CONTROL_PLANE_URL` sabitini build sırasında gömüyor.
- Supply-chain hattı (reproducible build, SBOM, cosign imza, in-toto/SLSA provenance,
  admission doğrulayıcı) WP29'da; public-release gate'i WP31'de
  (`release:public-preflight`) mevcut.

## Değerlendirilen seçenekler

### Dağıtım topolojisi

1. **Kubernetes/Helm chart** — üretim vaadi güçlü; fakat tek-VPS hedef kitlesi için
   kurulum ve işletme maliyeti yüksek, "tek komut" vaadini zayıflatır.
2. **Tek binary + SQLite** — en basit kurulum; fakat production contract'ları
   (RLS'li PostgreSQL, S3 uyumlu object storage, durable broker) fork edilmeden
   sağlanamaz; kapsam dışı fork yaratır.
3. **Version-pinned Docker Compose profili** _(seçildi)_ — production ile aynı
   servis contract'larını korur, tek komutla kurulabilir, upgrade/rollback ve
   yedekleme compose seviyesinde deterministik yönetilir.

### Reverse proxy ve TLS

1. **nginx + certbot** — yaygın; fakat iki ayrı hareketli parça, sertifika yenileme
   cron'u ve şablon karmaşası getirir.
2. **Traefik** — dinamik keşif özellikleri bu sabit topolojide gereksiz.
3. **Caddy 2** _(seçildi)_ — tek imajla otomatik ACME (HTTP-01), zorunlu HTTPS
   yönlendirmesi, `tls internal` ile hava-boşluklu/LAN kurulumu ve basit tek dosyalık
   yapılandırma. Compose içinde dışa açılan tek servis proxy'dir (80/443).

### Kimlik (OIDC)

1. **Keycloak bundle** — tam OIDC/SAML; fakat ~1 GB bellek ayak izi, realm yönetimi
   ve ayrı upgrade hattıyla tek-VPS kurulumunu ağırlaştırır.
2. **Auth yok / local mod** — `PERSISTENT_CODEX_LOCAL_ALPHA` dev adaptörü production
   sunucuda kapalıdır; güvensiz ve kapsam dışı.
3. **Gömülü minimal OIDC issuer + BYO-OIDC** _(seçildi)_ — wp30 `oidc-stub`
   deseninin sertleştirilmiş hali: kurulumda üretilen RSA anahtarıyla yalnız iç ağda
   discovery + JWKS sunan `identity` servisi; token basımı ağ üzerinden değil,
   yalnız `self-hosted.sh admin-token` → `docker exec` ile private key dosyasından
   yapılır. `OIDC_ISSUER`/`OIDC_AUDIENCE` config ile dış OIDC sağlayıcıya
   (ör. Keycloak) yönlendirilebilir. Kullanıcıya dönük OAuth login profilleri WP34
   kapsamındadır; bu ADR onu öne almaz.

### Uygulama imajı dağıtımı

1. **Yalnız registry'den prebuilt imaj** — repo henüz public registry yayını
   yapmıyor; kurulumun ilk sürümünü yayına bağımlı kılar.
2. **Kurulumda kaynaktan build** _(v1 varsayılanı)_ — doğrulanmış release
   bundle'ından `infra/self-hosted/product.Dockerfile` ile deterministik
   (`SOURCE_DATE_EPOCH`, digest-pinli base, non-root uid 10001) yerel build.
3. **İkisi birden** _(hedef durum)_ — `wp32:release-build` çok mimarili
   (linux/amd64 + linux/arm64) imaj üretimini tanımlar; registry yayını
   başladığında `PRODUCT_IMAGE` config'i prebuilt digest'e işaret eder ve kurulum
   cosign doğrulaması sonrası pull eder. Kaynaktan build yolu desteklenmeye devam
   eder.

### Migration çalıştırma

1. **initdb-only (wp30 deseni)** — upgrade'de yeni migration uygulanamaz; elenmiştir.
2. **Tracking tablolu idempotent runner** _(seçildi)_ — `persistent_codex_ops.schema_migrations`
   tablosu (dosya adı + sha256 + uygulanma sırası); her `install`/`upgrade`,
   pinlenmiş postgres imajıyla tek seferlik `migrate` compose servisi üzerinden
   uygulanmamış migration'ları sırayla `ON_ERROR_STOP` ile koşar. Daha önce
   uygulanmış bir dosyanın içeriği değişmişse (sha256 uyuşmazlığı) fail-closed durur.

### Yedekleme

1. **WAL arşivli PITR (wp27 deseni)** — en güçlü RPO; fakat sürekli arşiv alanı ve
   operasyon bilgisi ister; self-hosted v1 için varsayılan yapmak destek yükünü
   artırır.
2. **Soğuk volume kopyası** — stack durdurulmadan tutarsız olur.
3. **Uygulama-tutarlı `pg_dump` + object-storage arşivi, şifreli tek arşiv**
   _(seçildi)_ — `pg_dump -Fc` (custom format) + `object-data`/`workspace-data`
   volume tar'ları + üye sha256'larını taşıyan manifest, tek arşivde
   `openssl enc -aes-256-cbc -pbkdf2 -iter 200000` ile şifrelenir; ciphertext
   sha256'sı taşıma bütünlüğü için arşivin yanına yazılır, üye bütünlüğü şifreli
   manifest içindeki sha256'larla doğrulanır. Yedek anahtarı kurulumda üretilir,
   0600 izinli dosyada tutulur ve arşive asla dahil edilmez. PITR'a geçiş yolu
   runbook'ta `wp27:postgres-pitr` referansıyla belgelidir.

## Karar

### Compose topolojisi

`infra/self-hosted/compose.yml`, proje adı `persistent-self-hosted`, tüm kaynaklarda
`persistent.self-hosted=true` etiketi (yaşam döngüsü keşfi ve temizlik doğrulaması
yalnız bu etiketle yapılır — wp30 deseni):

| Servis            | İmaj                                                        | Görev                                     | Dışa açık port             |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------- | -------------------------- |
| `proxy`           | `caddy:2.10.2@sha256:c3d7…2adb`                             | TLS terminasyonu, ACME, yönlendirme       | 80, 443 (yalnız bu servis) |
| `postgres`        | `pgvector/pgvector:pg17@sha256:feb6…3966`                   | RLS'li veri düzlemi                       | —                          |
| `object-storage`  | `minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea…015e` | S3 uyumlu attachment/artifact deposu      | —                          |
| `broker`          | `rabbitmq:4.1.8-management@sha256:d501…edde`                | Durable event broker                      | —                          |
| `identity`        | `node:24-alpine@sha256:a0b9…fbfd`                           | İç OIDC discovery + JWKS                  | —                          |
| `migrate`         | postgres imajı (one-shot, `ops` profili)                    | Tracking tablolu migration runner         | —                          |
| `control-plane`   | product imajı                                               | Production API (`production-api-process`) | —                          |
| `workspace-agent` | product imajı                                               | Scheduler/worker + codex çalıştırma       | —                          |
| `web`             | product imajı                                               | SSR + PWA sunumu                          | —                          |
| `bootstrap`       | product imajı (one-shot, `ops` profili)                     | İlk admin + billing bootstrap             | —                          |
| `ops-shell`       | product imajı (one-shot, `ops` profili)                     | Yedek/geri yükleme volume yardımcıları    | —                          |

Yönlendirme: `/v1/*`, `/healthz`, `/readyz` → `control-plane:3300`; kalan her şey →
`web:3301`. WebSocket (`/v1/realtime`) aynı origin'den proxy'lenir; web istemcisi
`https:` origin'i `wss:`'e çevirdiği için ek yapılandırma gerekmez. CORS gereksizleşir;
`WEB_ALLOWED_ORIGIN` kanonik origin'e sabitlenir.

### İmaj sürümleme ve pinleme

- Tüm üçüncü parti imajlar `infra/self-hosted/images.env` içinde
  `tag@sha256:<multi-arch index digest>` biçiminde pinlidir; compose yalnız bu
  değişkenleri kullanır. Preflight, `docker image inspect` `RepoDigests` eşitliğini
  doğrular (wp30 `assertPinnedImage` sözleşmesi).
- Index digest'i pinlemek amd64 ve arm64'ü aynı anda sabitler; mimariye özgü digest
  çözümü Docker'a bırakılır.
- Product imajı `persistent-self-hosted-product:<source-commit>` olarak etiketlenir;
  kaynak commit'i kurulum durum dizinine kaydedilir ve upgrade/rollback bu kayıt
  üzerinden yürür.
- Cosign imajı wp29 ile aynı pin'dedir (`ghcr.io/sigstore/cosign/cosign:v2.5.3`);
  imza/provenance doğrulaması bu imajla, docker üzerinden koşar.

### Güvenli default config

- Dışa açık portlar yalnız proxy'nin 80/443'ü; diğer tüm servisler iç ağda kalır,
  host'a port yayınlamaz.
- Tüm secret'lar (postgres, minio, rabbitmq, backup anahtarı, identity RSA anahtarı,
  bootstrap parolaları) kurulumda `openssl rand` ile üretilir; `secrets/` dizini ve
  dosyaları 0600/0700 izinlidir, compose'a docker secret / bind dosya olarak geçer,
  environment'a plaintext yazılmaz (`POSTGRES_PASSWORD_FILE` deseni).
- TLS zorunludur: `SELF_HOSTED_TLS_MODE=acme` (varsayılan; domain + e-posta ister)
  veya `internal` (Caddy iç CA; LAN/hava-boşluklu kurulum) veya `custom`
  (operatör sertifikası). HTTP yalnız ACME challenge ve 308 HTTPS yönlendirmesi sunar.
- Postgres runtime bağlantısı `NOSUPERUSER`/`NOBYPASSRLS` `self_hosted_runtime`
  rolüyledir (wp30 `init.sql` deseni); migration'lar admin rolüyle koşar.
- Container'lar non-root (uid 10001) çalışır; `restart: unless-stopped` ve
  healthcheck'ler tüm servislerde zorunludur.
- Zorunlu telemetry yoktur: `OTEL_EXPORTER_OTLP_ENDPOINT` boş bırakıldığında hiçbir
  dış uç noktaya veri gitmez.

### local / self-hosted profil ayrımı

- `local` (alpha, `PERSISTENT_CODEX_LOCAL_ALPHA=1`): tek makine, SQLite/dev
  adaptörleri, dev auth. Değişmedi.
- `wp30-local`: operatör-lab kanıt sınıfı; loopback, TLS'siz, seed'li. Değişmedi.
- `self-hosted` (bu ADR): aynı production process'leri
  (`production-api-process`, `production-worker-process`), aynı contract'lar,
  internet'e dönük TLS'li topoloji, tracking tablolu migration, gerçek admin
  bootstrap. Çekirdek contract/UI/event semantiği fork edilmez; tek kod-değişikliği
  sınıfı, web istemcisinin API origin'ini runtime'da alabilmesi için build'e
  `https://public-origin.invalid` placeholder'ının gömülüp self-hosted web
  sunucusunda kanonik origin ile değiştirilmesidir (davranış eşdeğeri, profil
  fork'u değil).

### Kimlik ve ilk admin

- `identity` servisi yalnız iç ağda `http://identity:3303` issuer'ı ile discovery ve
  JWKS sunar; private key'i host'taki 0600 izinli secret dosyasındadır ve container'a
  salt-okunur bağlanır. Ağ üzerinden token basma ucu yoktur.
- `self-hosted.sh admin-token`, private key ile kısa ömürlü (varsayılan 4 saat)
  RS256 admin JWT'si basar; runbook PWA'ya oturum enjeksiyonunu belgeler. WP34 OAuth
  login profillerine kadar geçici, kayıtlı operatör akışıdır.
- `bootstrap` one-shot servisi idempotent biçimde ilk organizasyonu, admin
  `principal_identity`'sini (`issuer=http://identity:3303`), `owner` üyeliğini,
  workspace'i, `self-hosted-1` region'ını, kapasitesi host'tan ölçülen
  `runtime_nodes` kaydını, scheduling policy'yi ve `self_managed` billing planını
  oluşturur.
- `KMS_READINESS_URL` iç `identity` servisinin `/readyz` ucuna işaret eder (anahtar
  malzemesinin sahibi odur); `RUNTIME_CONTROL_READINESS_URL` workspace-agent
  health ucudur.

### Provider credential sınırı

- Codex subscription/device-auth credential'ı yalnız `codex-home` adlı docker
  volume'unda yaşar; `self-hosted.sh codex-login` komutu login akışını
  workspace-agent container'ı içinde (`CODEX_HOME=/codex-home`) çalıştırır.
  Credential host dosya sistemine, compose environment'ına, loglara ve state dizinine
  çıkmaz.
- Worker, her koşuda `createIsolatedCodexHome` ile geçici symlink home kullanır
  (ADR-0017 sınırı); provider adapter'larının `redactText` katmanı stdout/stderr'i
  temizlemeye devam eder.
- Yedekler `codex-home` volume'unu varsayılan olarak DIŞLAR;
  `--include-provider-credentials` bayrağıyla dahil edilirse bile arşiv her durumda
  şifrelidir. `wp32:credential-scan` gate'i dağıtım kaynaklarını, çalışan stack
  loglarını, yedek ve export arşivlerini plaintext credential kalıplarına karşı tarar.

### Yaşam döngüsü prosedürleri

- `install`: preflight → (bundle kuruluyorsa) checksum + cosign imza + provenance
  doğrulaması (wp29 admission sözleşmesi: repository, sourceCommit, artifactSha256,
  validUntil, revoked) → secret üretimi → imaj pull/build + digest doğrulama →
  altyapı servisleri → `migrate` → `bootstrap` → uygulama servisleri → iç ve public
  origin üzerinden health/readiness doğrulaması. Her adım fail-closed'dur.
- `upgrade`: otomatik ön-yedek → yeni sürüm doğrulaması (aynı imza/provenance
  hattı) → yeni product build/pull → `migrate` → servis güncelleme → health
  doğrulama; önceki sürüm kaydı rollback için saklanır.
- `rollback`: önceki imaj/kaynak kaydına dönüş + gerekiyorsa ön-yedekten restore.
  Migration politikası expand-only olduğundan (release-supply-chain `lintMigration`)
  şema geri alınmaz; veri kaybı yaşanmaz.
- `backup`/`restore`: yukarıdaki şifreli arşiv; restore uygulama servislerini
  durdurup `pg_restore --clean` + object-data geri yüklemesi yapar ve health
  doğrulamasıyla biter. Hiçbir senaryoda conversation/attachment kaybına izin
  verilmez; `wp32:lifecycle` gate'i bunu satır/obje sayımı ve içerik karşılaştırması
  ile kanıtlar.
- `uninstall`: zorunlu `--export` arşivi (şifreli) üretildikten sonra
  `persistent.self-hosted=true` etiketli tüm container/volume/network kaldırılır ve
  sıfır kalıntı doğrulanır (wp30 `down` sözleşmesi).

### Kabul gate'leri

`pnpm wp32:test | wp32:preflight | wp32:install-smoke | wp32:lifecycle |
wp32:credential-scan | wp32:golden | wp32:accept`. Evidence sözleşmesi wp30/wp31 ile
aynıdır: `machineEvidence`/`failNotRun`, `.wp32/evidence/` (gitignored),
timestamp'siz deterministik JSON, redaksiyon zorunlu. Docker/temiz-VPS/agent-browser
gerektiren adımlar ortam eksikse `status:'not-run'` + `accepted:false` raporlar ve
fail-closed sayılır; hiçbir not-run sonucu başarıya terfi ettirilmez.

## Sonuçlar

- Self-hosted kurulum tek belgelenmiş komuta iner:
  `bash infra/self-hosted/self-hosted.sh install --domain <fqdn> --acme-email <e-posta>`.
- Production contract'ları (RLS, S3, durable broker, OIDC, readiness) fork'suz korunur;
  wp30-local laboratuvarı ve gate'leri değişmeden kalır.
- Operatör, WP34'e kadar admin token'ını CLI'dan alır; bu bilinen ve runbook'lu bir
  sınırlamadır.
- Yedek şifreleme anahtarının kaybı yedekleri kurtarılamaz kılar; runbook anahtar
  saklamayı (escrow) zorunlu adım olarak belgeler.
- Registry yayını başladığında prebuilt multi-arch imajlara geçiş, yalnız
  `images.env`/config değişikliğiyle yapılır; kurulum akışı değişmez.
- PITR ihtiyacı olan operatörler için wp27 hattı uygulanabilir durumdadır; varsayılan
  yedek stratejisi bilinçli olarak daha basittir.
