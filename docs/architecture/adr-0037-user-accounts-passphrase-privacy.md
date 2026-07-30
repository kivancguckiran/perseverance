# ADR-0037 — Kullanıcı hesapları ve parola-türevli at-rest mahremiyet

- Durum: Kabul edildi (WP37, 28 Tem 2026)
- Karar sahipleri: proje sahibi + uygulama oturumu
- İlgili: ADR-0032 (self-hosted dağıtım), `docs/planning/project-closure-plan.md` WP37 bölümü

## Bağlam

Self-hosted dağıtım WP36'ya kadar tek admin öznesiyle (`admin-token` → docker
exec) çalışıyordu; web istemcisi `sessionStorage persistent.auth` enjeksiyonu ve
query-param scope'a dayanıyordu. Konuşma içeriği (prompt ve model çıktısı)
object storage'da düz metin duruyordu; makinede root erişimi olan operatör tüm
kullanıcı içeriğini okuyabiliyordu. Hedef kullanım (küçük, çok kullanıcılı
kurulum; kullanıcılar telefondan PWA ile girer) için kayıt/giriş akışı ve
"operatör dahi okuyamaz" düzeyinde at-rest mahremiyet gerekiyor.

## Karar

1. **Kimlik**: `persistent_codex.users` tablosu; parola doğrulaması Argon2id
   hash ile. Kayıt yalnız `SELF_HOSTED_ALLOWED_USERS` env allowlist'indeki
   adlara açıktır (fail-closed). Kayıt anında kullanıcıya kendi
   organization/workspace'i idempotent kurulur (bootstrap deseni + byok billing
   snapshot'ı); RLS + membership denetimi kullanıcılar arası izolasyonu sağlar.
2. **Token**: `/v1/auth/login` control-plane içinde, identity servisiyle aynı
   RS256 anahtar dosyasıyla (`/run/self-hosted/oidc-private.pem`, read-only
   mount) kısa ömürlü access token imzalar; JWKS yayını identity'de kalır ve
   identity hâlâ HTTP mint endpoint'i sunmaz. Oturum kalıcılığı, DB'de yalnız
   sha256 hash'i saklanan ve kullanımda rotate edilen opak refresh token ile
   sağlanır.
3. **Anahtar zinciri**: kullanıcı başına 32 baytlık rastgele **content key**
   üretilir. Bu anahtar (a) paroladan Argon2id+HKDF ile türetilen user-KEK ile,
   (b) kayıtta BİR KEZ gösterilen yüksek-entropili recovery key'den HKDF ile
   türetilen recovery-KEK ile ayrı ayrı sarılıp `user_content_keys` tablosunda
   saklanır. Parola, recovery key, KEK'ler ve çözülmüş content key diske asla
   yazılmaz; content key login'de çözülür ve control-plane belleğinde süreli
   **lease** olarak yaşar (audit: `secret.lease_issued/revoked`). Recovery
   akışı content key'i yeni parola-KEK ile yeniden sarar (`key.rotated`) ve
   eski recovery key'i geçersiz kılar. Parola + recovery key birlikte
   kaybolursa veri kurtarılamaz; operatör kurtarma anahtarı bilinçli olarak
   yoktur.
4. **İçerik şifreleme**: prompt ve model çıktısı object storage'a mevcut
   `EnvelopeEncryption` (AES-256-GCM, kayıt başına DEK) ile, DEK'i kullanıcının
   content key'ine bağlayan `UserContentKmsProvider` üzerinden şifreli yazılır
   (recordType `prompt` / `model_output`). `ha_events.payload` içerik değil
   referans taşır ve düz metin içermez. Workspace-agent, content key'i diske
   yazmadan, yalnız iç docker ağında dinleyen ayrı bir control-plane
   listener'ından (`content-key` iç API'si, dosya-tabanlı iç token ile) alır;
   Caddy bu portu yayınlamaz.
5. **Operatör işlemleri**: `self-hosted.sh list-users | disable-user |
reset-user --crypto-erase | set-allowed-users` komutları eklenir.
   Crypto-erase sarılmış content key kopyalarını siler; içerik kalıcı olarak
   çözülemez hale gelir (`workspace.crypto_erased`).

## Tehdit modeli ve bilinen sınırlar

- Garanti **at-rest** içindir: disk, DB, `pg_dump`, yedek arşivi (backup-key
  ile açılmış haliyle dahi) kullanıcı parolası olmadan konuşma içeriği vermez.
- Sistem çalışırken düz metin ve anahtarlar bellekte işlenir; runtime bellek
  erişimine, iç ağ trafiğini dinleyen root operatöre veya ürün kodunu kötü
  niyetle değiştiren operatöre karşı garanti verilmez (kapsam dışı).
- Workspace çalışma dizini (`workspace-data` volume) agent'ın ürettiği dosyaları
  düz metin tutar; konuşma geçmişi şifreleme kapsamı prompt/model çıktısı/olay
  kayıtlarıdır.
- Admin-token yolu operatör/acil akışı olarak kalır; admin öznesi kullanıcı
  organizasyonlarında üye değildir ve kullanıcı içeriği anahtarsız çözülemez.

## Sonuçlar

- Argon2id için `hash-wasm` (MIT, saf WASM; esbuild bundle'ına gömülür)
  bağımlılığı eklenir; SBOM/lisans artifact'leri yenilenir.
- `wp37:test` (birim) ve `wp37:privacy` (sandbox e2e, operatör-okuyamaz kanıtı)
  gate'leri kabul kapısına eklenir; wp32 gate'leri regresyonsuz kalır.
- Web'de login/kayıt sayfası gelir; scope token/oturum kaydından türetilir,
  `sessionStorage` enjeksiyonu son kullanıcı akışından kalkar.
