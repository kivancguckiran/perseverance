# WP38 Teslimat Raporu — Reverse-Proxy Altında Base-Path (Subpath) Deployment

- Tarih: 30 Temmuz 2026
- İş paketi: WP38 (ADR-0038) — `wp38-uygulama-promptu.md`
- Durum: **Mühendislik kabulü tamamlandı** — arm64 Linux sandbox'ta
  `wp38:subpath` ve tüm WP32/WP37 kök regresyon gate'leri tek kesintisiz
  zincirde geçti. Fiziksel telefon + operatör nginx doğrulaması yayın
  operasyonu olarak ayrıca kaydedilecektir.

## Commit zinciri

| Commit        | Mesaj                                                                                |
| ------------- | ------------------------------------------------------------------------------------ |
| `c692e7f`     | feat: add user accounts with passphrase-derived at-rest privacy (WP37, kabul edildi) |
| `2437efe`     | docs: insert wp38 subpath deployment and shift the release to wp39                   |
| **`6de641f`** | **feat: support base-path deployment behind a reverse proxy (WP38 aday)**            |

Tam hash: `6de641fadeada55339827d5645311ed0650983df`. Zincir
`_to_delete/wp36-transfer/wp38-repo.bundle` içindedir (komple history; device
main `877f3a6` üzerine 2707aab → fad1f65 → c692e7f → 2437efe → 6de641f).

## Seçilen strateji (ADR-0038)

**Hibrit: base path build-time, origin runtime.**

- Base path Vite `base` olarak build'e iner (`product.Dockerfile` build-arg →
  `VITE_BASE_PATH`); asset URL'leri, `import.meta.env.BASE_URL` ve TanStack
  Router `basepath` derleyici düzeyinde tutarlı olur. Product imajı zaten
  `install`/`upgrade` sırasında lokal build edildiğinden "tek build her
  base'de" özelliğinin alıcısı yok; derlenmiş chunk'larda kök-mutlak stringleri
  açılışta regex ile yeniden yazmak (runtime strateji) yanlış-pozitif ikame
  riski taşıyordu.
- Origin ikamesi mevcut mekanizmada kalır ve base'i kapsar:
  `self-hosted-web-server.mjs`, `https://public-origin.invalid` placeholder'ını
  artık `PUBLIC_ORIGIN + BASE_PATH` ile değiştirir → `apiBaseUrl` base içerir,
  tüm `/v1` çağrıları ve `/v1/realtime` WebSocket'i base altından akar.
- Boş base'te Vite base varsayılanı `/` olduğundan kök build çıktısı bire bir
  bugünküyle aynıdır (regresyon garantisi).

## Yapılan değişiklikler

1. **Yapılandırma**: `SELF_HOSTED_BASE_PATH` env + `install/upgrade
--base-path` bayrağı; `normalize_base_path` (başta `/`, sonda yok, segment
   `[A-Za-z0-9._~-]`, `.`/`..` ve rezerve kökler `/v1|/healthz|/readyz|/assets|/events`
   fail-closed); preflight'a `base-path-valid` kontrolü; env kalıcılığı ve
   upgrade'de idempotent ekleme. İmaj tag'i base slug'ı içerir
   (`<commit>-workspace`) → base değişikliği yeni build tetikler; release
   state artık imaj referansını da taşır (rollback slug'lı tag'i state'ten okur).
2. **Web**: Vite `base`; router `basepath`; `base-path.ts` (`withBase`)
   yardımcıları; `__root.tsx` manifest/ikon linkleri, SW kaydı
   (`{base}/sw.js?v=wp38-v1`, scope `{base}/`), connectivity probe, bildirim
   yönlendirmesi, `/login` yönlendirmeleri base farkındalı. Bulunan gerçek
   hata: `new URL('/v1/realtime', apiBaseUrl)` deseni base'i düşürüyordu
   (workspace-page + production-session-page) — string birleştirmeye çevrildi
   ve regresyon testi eklendi.
3. **PWA**: manifest relative üyelere geçti (`start_url/scope/id: "./"`,
   relative ikonlar); `sw.js` scope'unu `new URL('./', self.location)` ile
   türetir — precache/never-cache listeleri, offline navigate fallback'i
   (`caches.match(BASE)`), bildirim ikon/hedefleri base ile kurulur. Cache
   sürümü `wp38-v1`.
4. **Sunucu**: `self-hosted-web-server.mjs` `BASE_PATH` env'i ile: statik +
   SSR base altından, tam `{base}` ve kök `/` istekleri `{base}/`'e 308,
   base dışı yollar 404; kök `/healthz|/readyz` korunur (compose healthcheck +
   monitoring). Caddy şablonu placeholder'lı: `{base}/v1/* {base}/healthz
{base}/readyz` → `uri strip_prefix` ile control-plane; kök health
   passthrough sürer; boş base'te render bugünkü davranışla bire bir.
   `wait_public_ready` readiness'ı `{origin}{base}/readyz` üzerinden doğrular.
5. **Kanıt**: `pnpm wp38:subpath` (scripts/wp38-gate.ts): sandbox kurulum
   `/workspace` base'i ile; operatör topolojisinin eşleniği dış proxy (pinli
   Caddy imajı, Host catch-all :8080 + path-prefix, **URI strip yok** — nginx
   `location ^~ /workspace/` muadili) arkasından: kök redirect/404
   sözleşmesi, manifest/SW scope, SSR HTML + asset'ler base altında,
   kayıt→login→session→turn→event replay, `/v1/realtime` WebSocket upgrade,
   deployed `sw.js` ile offline replay (VM harness + gerçek precache
   fetch'leri) ve uninstall sıfır-kalıntı. Ek birim testleri:
   `scripts/wp38.test.ts` (25 test) + `pwa-assets.test.ts`'e base-scope
   SW testleri.
6. **Dokümantasyon**: kurulum runbook'una subpath bölümü + operatörün
   `locations-enabled/*.location.conf` düzenine birebir uyan nginx örneği
   (WebSocket upgrade başlıkları ve `proxy_pass`'e sondaki `/`'ın
   KONMAMASI uyarısı dahil); ADR-0038; plan dokümanlarında WP38/WP39
   yeniden numaralandırması (`2437efe`).

## Gate sonuçları (cloud, `6de641f`)

| Doğrulama                                    | Sonuç                                                       |
| -------------------------------------------- | ----------------------------------------------------------- |
| `pnpm verify`                                | ✅ 62 dosya / 602 test                                      |
| `pnpm wp32:test`                             | ✅                                                          |
| `pnpm wp37:test`                             | ✅                                                          |
| `pnpm wp38:subpath`                          | ✅ arm64 Linux; proxy/base/PWA/API/WebSocket/offline replay |
| `pnpm wp32:install-smoke` / `wp32:lifecycle` | ✅ arm64 Linux                                              |
| `pnpm wp32:credential-scan`                  | ✅ statik 0, runtime 0 bulgu                                |
| `pnpm wp37:privacy`                          | ✅ arm64 Linux                                              |
| `pnpm release:public-preflight` ×2           | ✅ ACCEPTED, evidence bayt-aynı `da076c67534c074d…`         |

Final arm64 kanıtı:
`_to_delete/wp36-transfer/wp38-evidence-arm64-final.tgz`;
SHA-256 `35e4224c9641d7406e47b2c19d460b5ddf278b23ce355ac4146a1911e2f73016`.

## Kapanışta giderilen gerçek hatalar

1. Self-hosted `byok` planı bilerek platform kredisi taşımamasına rağmen
   commercial admission her plan için prepaid rezervasyon yapıyor ve turn'ü
   `HARD_LIMIT_PREPAID_CREDIT` ile reddediyordu. Prepaid rezervasyon artık
   yalnız `platform_managed` ve `hybrid` planlarda uygulanır; birim regresyon
   testi eklendi.
2. RabbitMQ healthcheck'i entrypoint Erlang cookie hazırlığını bitirmeden
   başlayabiliyor, cookie'yi root sahipli oluşturup ilk broker açılışını
   `EACCES` ile düşürebiliyordu. Broker healthcheck'ine `start_period: 30s`
   eklendi ve WP32 statik regresyon testiyle sabitlendi.
3. SBOM envanteri platform paketlerini eliyor fakat yalnız bu paketlerden
   erişilen transitif WASM bağımlılıklarını tutuyordu; temiz macOS ve Linux
   kurulumları farklı SBOM üretebiliyordu. Platforma özel bağımlılık kapanışı
   da elenerek iki platformda aynı commit edilmiş SBOM doğrulandı.

Ek cloud kanıtı: base'li web build + SSR sunucusu docker'sız lokal smoke ile
doğrulandı — `/workspace/` altında SSR HTML/asset/manifest/sw.js 200, kök `/`
ve tam `/workspace` → `/workspace/` 308, base dışı 404, kök `/readyz` korunur,
servis edilen chunk'ta `https://localhost/workspace` ikamesi (placeholder 0).

## iMac koşusu (tamamlanan kanıt)

`_to_delete/wp36-transfer/` içinde: `wp38-repo.bundle` (head `6de641f`),
`wp38-run.sh` (v1, EXPECTED_HEAD pinli), `wp38-imac.sh` (container
`wp38-arm64`, volume `wp38-inner-docker`).

```bash
cd _to_delete/wp36-transfer && bash wp38-imac.sh
```

Gate sırası: wp32:preflight → wp32:test → wp37:test → **wp38:subpath** →
wp32:install-smoke → wp32:lifecycle → wp32:credential-scan → wp37:privacy.
Çıktı:
`_to_delete/wp36-transfer/wp38-evidence-arm64-final.tgz` (SHA-256 yukarıda).

## Kabul kriterleri durumu

- [x] `wp38:subpath` sandbox'ta geçer
- [x] Boş base ile `wp32:*` + `wp37:*` regresyonsuz
- [ ] Gerçek kurulumda operatör nginx'i altında `/workspace/` prefix ile
      telefon/PWA akışı uçtan uca + redakte kanıt (kullanıcı tarafı)
- [x] `pnpm verify` geçer
- [x] `release:public-preflight` ×2 ACCEPTED, evidence bayt-aynı

## Notlar / bilinen sınırlar

- Base path build-time'dır: değer değişikliği `install`/`upgrade` ile yeni
  imaj build'i gerektirir (ADR-0038'de gerekçeli). Aynı origin'de çoklu
  eşzamanlı base / çoklu instance kapsam dışıdır.
- wp29 imzalı release imajları kök base ile üretilir; subpath operatörü
  kaynaktan kurar (varsayılan yol).
- `wp32:golden` browser eval'i `fetch('/manifest.webmanifest')` kullanır —
  kök kurulum hedefler; base'li kurulumda golden koşulacaksa bu ifade base
  farkındalı yapılmalıdır (bilinçli olarak WP38 kapsamı dışında bırakıldı,
  gerçek-ortam PWA kanıtı kabul kriterindeki manuel akıştır).
