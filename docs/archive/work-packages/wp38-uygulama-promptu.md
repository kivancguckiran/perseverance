# WP38 Uygulama Prompt'u — Reverse-Proxy Altında Base-Path (Subpath) Deployment

Aşağıdaki prompt, uygulama task'ına olduğu gibi verilebilir. WP37 bağımsız
kabul edilmeden BAŞLATILMAZ (tek aktif iş paketi kuralı).

## İş paketi ve hedef

WP38 — Reverse-proxy altında base-path (subpath) deployment desteği. Hedefin:
self-hosted kurulumun tek bir yapılandırma değeriyle
(`SELF_HOSTED_BASE_PATH=/workspace` gibi) bir reverse proxy'nin alt-path'i
altında **tam işlevle** çalışabilmesi: PWA kurulumu, service worker/offline
replay, SSE turn stream'leri ve tüm API dahil. Boş base-path (kök) davranışı
bire bir korunur — mevcut kurulumlar hiçbir şey fark etmez.

Motivasyon (gerçek kullanım): operatörün mevcut altyapısı, tek bir ngrok
domain'inin arkasında Host catch-all'lı bir nginx (`listen 8080 default_server`)
ve `locations-enabled/*.location.conf` path-prefix include'larıyla çok servis
barındırıyor. Uygulama bugün origin kökünü varsaydığı için bu yapıya monte
edilemiyor; ayrı domain'le çalışıyor. Bu WP sonrası `location ^~ /workspace/`
tarzı bir include yeterli olacak.

## Bağlam — kökü varsayan yerler (repo'da doğrulanmış envanter)

- `apps/web/src/pwa-runtime.tsx`: `serviceWorkerUrl = '/sw.js?v=wp23-v1'`
  (kök-mutlak SW kaydı).
- `apps/web/public/manifest.webmanifest`: `"start_url": "/"`, `"scope": "/"`.
- `apps/web/public/sw.js`: precache listesi kök-mutlak (`/manifest.webmanifest`,
  `/icon-*.png`, `/v1/`, `/readyz`, `/healthz`, `/events`).
- `apps/web/src/workspace-page.tsx`: `apiBaseUrl` + `fetch(`${apiBaseUrl}/v1/...`)`
  çağrıları; `/sessions/<id>` kök-mutlak route kullanımları (≈16 yer).
- SSR sunucusu ve Caddy (`infra/self-hosted/config/Caddyfile.tmpl`) route'ları
  kökten servis ediyor; `self-hosted.sh install` bayrakları arasında base-path
  yok.
- NOT: product imajı `install` sırasında lokal build ediliyor — base-path'in
  build-arg olarak inmesi mimari olarak kabul edilebilir; build-time mı
  runtime-config mi kararını sen ver, kısa bir ADR ile gerekçelendir
  (mevcut ADR düzeni `docs/adr/`). Runtime-config (tek build, her base'de
  çalışır) tercih ediliyorsa relative-path stratejisi de meşrudur.

## Yapılacak işler

1. **Yapılandırma yüzeyi:** `SELF_HOSTED_BASE_PATH` env + `self-hosted.sh
install --base-path /workspace` bayrağı; normalizasyon (başta `/`, sonda
   yok; boş = kök) ve env kalıcılığı; preflight'ta geçersiz değere fail-closed.
2. **Web:** Vite `base` (veya seçilen runtime stratejisi), router yolları,
   `apiBaseUrl`, manifest `start_url`/`scope`, SW kayıt URL'i ve `sw.js`
   precache listesi base-path altında doğru; SW scope kuralı gereği `sw.js`
   base altından servis edilir.
3. **Sunucu:** SSR ve Caddy route'ları base-path farkındalı; `/{base}/` dışı
   istekler için davranış belgelenir (404 veya base'e redirect — seç, belgele).
   Health endpoint'lerinin (`/readyz`, `/healthz`) base altındaki karşılıkları
   netleştirilir (lifecycle/monitoring script'leri güncellenir).
4. **Kanıt gate'i `wp38:subpath` (sandbox e2e):** prefix'li reverse-proxy
   simülasyonu (nginx veya Caddy container'ı, operatörün gerçek yapısındaki
   gibi Host catch-all + `location ^~ /workspace/`) arkasında kurulum;
   şunlar base altında kanıtlanır: manifest/SW scope doğrulaması, kayıt→akış
   API çağrıları, SSE stream, PWA offline replay; artı kök kurulum regresyonu
   (`wp32:*` sandbox gate'leri boş base ile yeşil).
5. **Dokümantasyon:** kurulum runbook'una nginx `location ^~` örneğiyle
   subpath bölümü (operatörün include düzenine birebir uyan bir
   `*.location.conf` örneği dahil).

## Kapsam dışı işler

- Aynı origin'de birden fazla eşzamanlı base-path / çoklu instance.
- Path tabanlı çoklu-tenant yönlendirme.
- Yeni özellik/uç nokta; WP37 yüzeyinde değişiklik (login sayfası da base
  altında çalışır, o kadar).

## Kabul kriterleri

- `wp38:subpath` sandbox'ta geçer; boş base-path ile `wp32:*` ve `wp37:*`
  gate'leri regresyonsuz (WP37 bu WP'den önce kabul edilmiş olacak — login
  akışı ve privacy gate'i base altında da, kökte de çalışır).
- Gerçek kurulumda (operatörün nginx'i altında `/workspace/` benzeri prefix)
  telefon/PWA akışı uçtan uca çalışır ve redakte kanıtla raporlanır.
- `pnpm verify` geçer; `pnpm release:public-preflight` ardışık iki koşuda
  ACCEPTED ve evidence bayt-aynı.

## Çalıştırılacak doğrulama komutları

```bash
pnpm verify
pnpm wp32:test
pnpm wp37:test             # regresyon
pnpm wp38:subpath          # sandbox (docker gerektirir)
pnpm wp37:privacy          # kök regresyon (sandbox)
pnpm wp32:install-smoke    # kök regresyon
pnpm wp32:lifecycle        # kök regresyon
pnpm wp32:credential-scan
pnpm release:public-preflight   # 2 kez; evidence hash'leri karşılaştır
```

## Teslimat commit'i

Ana dal WP37 teslimat commit'i üzerindesin. Gerekirse ADR ayrı docs commit'i;
tüm doğrulamalar geçince tek uygulama commit'i:
`feat: support base-path deployment behind a reverse proxy`
Teslimat raporuna commit hash'i, gate sonuçları ve seçilen strateji (build-arg
vs runtime) yazılır.
