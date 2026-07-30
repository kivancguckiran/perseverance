# WP37 Teslimat Raporu — Kullanıcı Hesapları ve Parola-Türevli At-Rest Mahremiyet

Tarih: 28 Temmuz 2026 · Durum: **Aday teslimat — sandbox kanıt koşusu iMac'te bekliyor**

## Commit zinciri

| Commit        | Mesaj                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| `877f3a6`     | docs: retire wp35 and activate the project closure plan (cihaz main)            |
| `2707aab`     | docs: accept the arm64 real-environment evidence and insert wp37                |
| `fad1f65`     | fix: validate self-hosted distribution on a real linux host (WP36 teslimat)     |
| **`c692e7f`** | **feat: add user accounts with passphrase-derived at-rest privacy (WP37 aday)** |

Plan dokümanları (`project-closure-plan.md`, `work-package-management.md`)
WP37/WP38 revizyonunu `2707aab` ile zaten içerdiğinden ayrı docs commit'i
gerekmedi.

> **Taban notu:** cihazdaki `wp36-vps.sh` v13 `EXPECTED_HEAD=1aedcc92…`
> bekliyor, ancak aynı klasördeki `wp36-repo.bundle`'ın head'i `fad1f65`.
> `1aedcc92` bu oturuma ulaşan hiçbir artefakta yok; WP37 bundle'daki gerçek
> zincir (`fad1f65`) üzerine inşa edildi. `1aedcc92` önceki bir oturumda
> üretilip bundle'ı cihaza ulaşmadıysa içeriği kayıptır — farkı hatırlıyorsan
> bildir; değilse geçerli zincir `fad1f65 → c692e7f`'dir.

## Ne eklendi

- **Kimlik:** `persistent_codex.users` (+`user_content_keys`,
  `user_refresh_tokens`, `user_auth_audit`) — migration `0038`, RLS forced.
  Kayıt yalnız `SELF_HOSTED_ALLOWED_USERS` allowlist'ine açık (fail-closed +
  audit). Parola Argon2id (hash-wasm, MIT; SBOM yenilendi).
- **API:** `POST /v1/auth/register|login|refresh|recover|logout` (pre-auth,
  rate-limit'li, zamanlama-dengelemeli), `GET /v1/auth/session`, `GET /v1/me`
  (production sunucusuna eklendi), `GET /v1/runs/:id/input`. Access token'ı
  control-plane, identity ile paylaşılan RS256 anahtar dosyasıyla imzalar
  (identity'de HTTP mint ucu yine yok); oturum kalıcılığı hash'lenmiş,
  rotate edilen opak refresh token'la.
- **Anahtar zinciri (ADR-0037):** kullanıcı başına 32B content key; (a)
  Argon2id+HKDF parola-KEK, (b) kayıtta BİR KEZ gösterilen recovery key'den
  türetilen recovery-KEK ile ayrı ayrı sarılır. Recovery-KEK, recovery key'in
  KENDİSİNDEN türetilir; DB'de yalnız tek yönlü sha256 doğrulama hash'i durur.
  Çözülmüş anahtar yalnız bellekte lease olarak yaşar
  (`secret.lease_issued/revoked` audit); recovery akışı yeniden sarar
  (`key.rotated`) ve eski kodu geçersizleştirir.
- **İçerik şifreleme:** prompt ve model çıktısı object storage'a
  `EnvelopeV1` (AES-256-GCM, kayıt başına DEK, `UserContentKmsProvider`)
  olarak yazılır; `ha_events.payload` zaten içerik taşımıyor. Workspace-agent
  content key'i yalnız iç ağda dinleyen (Caddy'nin yayınlamadığı, dosya-token
  korumalı) 3304 listener'ından alır. Lease yokken turn `428
CONTENT_KEY_LOCKED` ile fail-closed reddedilir; düz metin fallback yok.
- **Operatör CLI:** `list-users | disable-user | reset-user --crypto-erase |
set-allowed-users` (idempotent + audit; crypto-erase geri döndürülemez).
- **Web:** `/login` sayfası (kayıt/giriş/kurtarma, recovery key onay ekranı,
  Türkçe); scope ve token login yanıtından storage'a — `sessionStorage`
  enjeksiyonu ve query-param scope'u son kullanıcı akışından kalktı
  (admin-token yalnız operatör/acil yolu); PWA yeniden açılışta refresh
  token'la parolasız sürer, içerik anahtarı gerektiğinde parola yeniden
  istenir; çıkış butonu.
- **Gate'ler:** `wp37:test` (birim) ve `wp37:privacy` (sandbox e2e:
  pg_dump/object-storage/ÇÖZÜLMÜŞ yedek içinde düz metin 0; restart→parola
  ile açılır; parolasız 428, yanlış parola 401; recovery rotasyonu;
  allowlist reddi; crypto-erase kalıcılığı; sıfır kalıntı).
- **Doküman:** ADR-0037, kurulum runbook'una kullanıcı yönetimi bölümü,
  README'ye tehdit modeli ve bilinen sınırlar (çalışırken bellek, workspace
  çalışma dizini, kötü niyetli kod değişikliği kapsam dışı).

## Gate durumu

| Gate                                                     | Sonuç                                                 | Ortam          |
| -------------------------------------------------------- | ----------------------------------------------------- | -------------- |
| `pnpm verify` (format+typecheck+test+build+SSR)          | ✅ geçti (562 test)                                   | cloud, Node 22 |
| `pnpm wp32:test`                                         | ✅ geçti                                              | cloud          |
| `pnpm wp37:test`                                         | ✅ geçti                                              | cloud          |
| `pnpm release:public-preflight` ×2                       | ✅ ACCEPTED, evidence bayt-aynı (`b5bba542bedb2399…`) | cloud          |
| `wp32:preflight/install-smoke/lifecycle/credential-scan` | ⏳ docker gerektirir — iMac koşusu                    | `wp37-imac.sh` |
| `wp37:privacy`                                           | ⏳ docker gerektirir — iMac koşusu                    | `wp37-imac.sh` |

## iMac koşusu (kabul için zorunlu)

`_to_delete/wp36-transfer/` klasörüne eklendi: `wp37-repo.bundle` (head
`c692e7f`), `wp37-run.sh` (v1, EXPECTED_HEAD pinli), `wp37-imac.sh`.

```bash
cd ~/Desktop/Workspace/persistent-agent/_to_delete/wp36-transfer
bash wp37-imac.sh          # tam koşu; sonunda wp37-evidence-arm64.tgz üretir
```

Kanıt paketini sohbete yükle; gate'ler geçince WP37 kabul edilir ve zincir
cihaz main'ine teslim edilir (lock yöntemiyle).

## Tehdit modeli beyanı

Garanti **at-rest** içindir: operatör dahil kimse, kullanıcının parolası veya
recovery key'i olmadan konuşma içeriğini diskten/DB'den/pg_dump'tan/yedekten
(backup-key ile açılmış haliyle dahi) okuyamaz. Bilinen sınırlar: çalışır
durumda bellek ve iç ağ runtime güven zarfındadır; workspace çalışma dizini
şifreleme kapsamı dışındadır; operatörün kötü niyetli kod değiştirmesine karşı
garanti verilmez; parola + recovery key birlikte kaybolursa veri kurtarılamaz
(operatör kurtarma anahtarı bilinçli yoktur). Ayrıntı: ADR-0037.
