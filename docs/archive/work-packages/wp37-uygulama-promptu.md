# WP37 Uygulama Prompt'u — Kullanıcı Hesapları ve Parola-Türevli At-Rest Mahremiyet

Aşağıdaki prompt, uygulama task'ına olduğu gibi verilebilir.

## İş paketi ve hedef

WP37 — Kullanıcı hesapları ve parola-türevli at-rest mahremiyet. Hedefin:
self-hosted dağıtıma kayıt/giriş akışı, env-allowlist'li kullanıcı kapısı ve her
kullanıcının konuşma içeriğinin **parolasından türetilen, diske asla
yazılmayan** bir anahtarla şifrelenmesini eklemek. Sonuç garantisi: makinede
root erişimi olan operatör dahil hiç kimse, kullanıcının parolası olmadan o
kullanıcının konuşma geçmişini ve mesajlarını **diskten/DB'den/yedekten
okuyamaz**. (Bilinen ve belgelenecek sınır: sistem çalışırken düz metin bellekte
işlenir; runtime bellek erişimine karşı koruma bu WP'nin hedefi değildir.)

Bağlam:

- Ana dal WP36 teslimat commit'i üzerindesin (`fix: validate self-hosted
distribution on a real linux host`). WP36 gerçek-ortam gate'leri kapatıldı.
- Kapanış planı revize edilmiş ve REPO'YA İŞLENMİŞ durumda (`docs: accept the
arm64 real-environment evidence and insert wp37-wp38` commit'i): bu özellik
  WP37'dir; WP38 = subpath deployment, v1.0 release + kapanış = WP39. Plan
  dokümanlarını YENİDEN düzenleme — yalnız kabul kayıtlarını güncelleyeceksin.
- Mevcut altyapı üzerine inşa et, paralel sistem kurma:
  - Envelope encryption: `persistent_codex.sensitive_records`
    (prompt/model_output/raw_event; AES-256-GCM, kayıt başına DEK,
    `packages/workspace-security` `KmsProvider`/`LocalKmsProvider`).
  - Audit: `workspace_security_audit` (`secret.lease_issued/revoked`,
    `key.rotated`, `workspace.crypto_erased` aksiyonları hazır).
  - Kimlik: iç `identity` OIDC issuer'ı (mint yalnız `admin-token` → docker
    exec). Web şu an `sessionStorage persistent.auth` enjeksiyonu ve query'siz
    `ten_local/wsp_local` scope default'u kullanıyor — ikisi de bu WP'de
    son kullanıcı akışından kaldırılır.
  - RLS/tenant izolasyonu ve workspace başına bootstrap deseni
    (`infra/self-hosted/bootstrap/self-hosted-bootstrap.ts`) mevcut.

## Kullanıcı kararları (bağlayıcı, 28 Tem 2026)

- Onay mekanizması: **env allowlist** — izinli kullanıcı adları kurulum
  yapılandırmasına yazılır (`SELF_HOSTED_ALLOWED_USERS=ad1,ad2`,
  `self-hosted.env` içinde; değişiklik `self-hosted.sh` üzerinden uygulanır).
  Yalnız listedeki adlar kayıt olabilir; liste dışı kayıt denemesi fail-closed
  reddedilir ve audit'e düşer.
- Parola kaybı politikası: **recovery key** — kayıt sırasında kullanıcıya BİR
  KEZ gösterilen bir kurtarma kodu üretilir (içerik anahtarının, kurtarma
  kodundan türetilen ikinci bir KEK ile sarılmış kopyası). Kod makinede
  SAKLANMAZ; kullanıcı saklar. Parola unutulursa kodla yeni parola belirlenir
  (içerik anahtarı yeni parola-KEK ile yeniden sarılır). Parola VE kod birlikte
  kaybolursa veri kurtarılamaz; hesap crypto-erase ile sıfırlanır. Operatör
  kurtarma anahtarı BİLİNÇLİ olarak yoktur (mahremiyet garantisinin gereği).
- Hedef kullanım: küçük kurulum (ör. 2 kullanıcı) ama tasarım genel N kullanıcı.

## Yapılacak işler

1. **Kullanıcı modeli ve migration:** `persistent_codex.users` (user_id,
   username benzersiz, argon2id parola hash'i, status: active|disabled,
   created_at, disabled_at; onay durumu YOK — kapı env allowlist'tir) +
   kullanıcı↔organization/workspace eşlemesi. Migration mevcut tracking
   tablosu düzeniyle (sha256 fail-closed) eklenir.
2. **Kayıt/giriş API'si:** `POST /v1/auth/register` (yalnız
   `SELF_HOSTED_ALLOWED_USERS` listesindeki adlar; username+parola; Argon2id;
   kayıt yanıtında BİR KEZ gösterilen recovery key üretilir),
   `POST /v1/auth/login` (iç OIDC issuer'dan kullanıcı öznesiyle kısa ömürlü
   access token + yenileme yolu; PWA'da oturum kalıcılığı sağlanır),
   `POST /v1/auth/recover` (recovery key ile yeni parola belirleme; içerik
   anahtarı yeni parola-KEK ile yeniden sarılır, kullanılan recovery key
   geçersizleşir ve yenisi üretilip bir kez gösterilir),
   `POST /v1/auth/logout`. Rate-limit ve zamanlama-sızıntısız karşılaştırma.
   Liste dışı/disabled girişimleri audit'e düşer.
3. **Operatör CLI:** `self-hosted.sh list-users` | `disable-user <ad>` |
   `reset-user <ad> --crypto-erase` (parola + recovery key birlikte
   kaybedildiğinde: mevcut `workspace.crypto_erased` aksiyonuyla içerik
   anahtarları imha edilir, hesap sıfırdan başlar). Allowlist değişikliği env
   üzerinden yapılır ve `self-hosted.sh` bunu servislere yansıtır. Tümü
   idempotent ve audit'li.
4. **Kullanıcı başına workspace bootstrap'i (TAM izolasyon):** İlk girişte
   kullanıcıya kendi organization/workspace'i + billing snapshot'ı (mevcut
   `developmentSeed` deseni, byok) idempotent kurulur. İzolasyon yalnız
   konuşma satırları değil, kullanıcıya ait HER kalıcı varlık içindir:
   - DB satırları: RLS ile workspace-scoped.
   - Dosya ekleri / artifact'ler / export'lar: object storage anahtarları
     workspace-prefix'lidir; bir kullanıcının token'ıyla diğerinin nesnesine
     erişim denemesi fail-closed reddedilir ve audit'e düşer.
   - Agent çalışma alanı (kalıcı workspace dosya sistemi ve session sandbox
     dizinleri): workspace başına ayrıdır; bir kullanıcının session'ı diğer
     kullanıcının çalışma alanını mount edemez/okuyamaz/listeleyemez.
     Paylaşılan kalanlar bilinçli ve belgelidir: tek runtime node (compute) ve
     operatörün tek codex provider credential'ı (tüm kullanıcılar aynı provider
     hesabının kotasını kullanır) — kullanıcı başına ayrı provider hesabı bu
     WP'nin kapsamı dışındadır ve dokümantasyonda açıkça beyan edilir.
5. **Web:** Login/kayıt sayfası; scope (organization/workspace) query
   param/default yerine **token claim'lerinden** türetilir; `sessionStorage
persistent.auth` enjeksiyonu son kullanıcı akışından kaldırılır (admin-token
   yalnız operatör/acil akışı olarak kalır ve UI'de ayrı, açık etiketli bir yol
   olur). PWA yeniden açılışında oturum, yenileme akışıyla parolasız sürer;
   içerik anahtarı gerektiğinde (bkz. 6) parola yeniden istenir.
6. **Parola-türevli içerik anahtarı + recovery key:** Kullanıcı parolasından
   Argon2id (+HKDF) ile user-KEK türetilir; kullanıcının workspace içerik
   anahtarı bu KEK'le sarılır; `sensitive_records` DEK'leri mevcut zincirle bu
   içerik anahtarına bağlanır. İçerik anahtarının İKİNCİ bir sarılmış kopyası,
   kayıt sırasında üretilen yüksek-entropili recovery key'den türetilen KEK ile
   tutulur (recovery key düz halde makinede SAKLANMAZ; yalnız doğrulama için
   hash'i durur). user-KEK ve çözülmüş içerik anahtarı **yalnız bellekte** yaşar
   (login'de türetilir, lease olarak tutulur; logout/expiry'de silinir; audit:
   `secret.lease_issued/revoked`). Parola değişimi/recovery: doğrulama sonrası
   içerik anahtarı yeni KEK'le yeniden sarılır (`key.rotated`). Diskte, env'de,
   logta, yedekte parola/recovery key/KEK/çözülmüş anahtar ASLA bulunmaz.
7. **Operatör-okuyamaz kanıt gate'leri:** `wp37:test` (statik birim testleri) +
   `wp37:privacy` (sandbox e2e): allowlist'li kayıt → login → gerçek mesaj yaz →
   (a) postgres'te ve pg_dump çıktısında mesaj düz metni 0 eşleşme,
   (b) yedek arşivinde düz metin 0 eşleşme, (c) stack restart sonrası doğru
   parolayla içerik açılır, (d) parolasız/yanlış parolayla açılamaz,
   (e) recovery key ile parola sıfırlama sonrası içerik erişilebilir kalır ve
   eski recovery key geçersizdir, (f) allowlist dışı kayıt reddedilir,
   (g) `reset-user --crypto-erase` sonrası eski içerik kalıcı olarak
   çözülemez. Evidence redakte ve timestamp'siz yazılır.
8. **Dokümantasyon:** Kurulum/işletme runbook'larına kullanıcı yönetimi bölümü;
   README'ye tehdit modeli ve **bilinen sınır** beyanı (çalışır durumda bellek;
   operatörün kötü niyetli kod değiştirme olasılığına karşı garanti verilmediği).

## Kapsam dışı işler

- Uçtan-uca (istemci tarafı) şifreleme; runtime bellek koruması.
- OAuth/social login, e-posta doğrulama, parola sıfırlama e-postası.
- Operatör kurtarma anahtarı (bilinçli yok).
- Managed cloud profili; WP36 dışı altyapı değişiklikleri.

## Kabul kriterleri

- Allowlist dışı kullanıcı kayıt olamaz; listedeki kullanıcı kayıt→giriş→mesaj
  akışını telefondan (PWA) parola ile tamamlar; recovery key kayıtta bir kez
  gösterilir ve parola sıfırlamada çalışır; admin-token son kullanıcı akışında
  kullanılmaz.
- `wp37:privacy` sandbox'ta geçer: DB/dump/yedekte düz metin 0; parolasız
  erişim mümkün değil; restart sonrası parolayla erişim sürüyor; recovery
  akışı çalışıyor; crypto-erase geri döndürülemez.
- Kullanıcılar birbirinin konuşmalarını, dosyalarını/attachment'larını ve
  agent çalışma alanlarını göremez (RLS + scope + storage-anahtarı +
  dosya-sistemi izolasyon testleri; çapraz erişim denemeleri audit'e düşer).
- `pnpm verify`, `wp32:test` ve mevcut wp32 sandbox gate'leri regresyonsuz.
- `pnpm release:public-preflight` ardışık iki koşuda ACCEPTED, evidence
  bayt-aynı.
- Parola/KEK/içerik anahtarı hiçbir log, env dump, yedek veya evidence
  çıktısında görünmez (`wp32:credential-scan` + wp37 taramaları 0 bulgu).

## Çalıştırılacak doğrulama komutları

```bash
pnpm verify
pnpm wp32:test
pnpm wp37:test
pnpm wp37:privacy          # sandbox (docker gerektirir)
pnpm wp32:install-smoke    # regresyon
pnpm wp32:lifecycle        # regresyon (kullanıcılı veriyle)
pnpm wp32:credential-scan
pnpm release:public-preflight   # 2 kez; evidence hash'leri karşılaştır
```

## Teslimat commit'i

Plan dokümanları zaten güncel (yeniden düzenleme). Tüm doğrulamalar geçince
tek uygulama commit'i:
`feat: add user accounts with passphrase-derived at-rest privacy`
Teslimat raporuna commit hash'i, gate sonuçları ve tehdit modeli beyanı yazılır.
