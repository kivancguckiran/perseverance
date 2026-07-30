# ADR-0038 — Reverse-proxy altında base-path (subpath) deployment

- Durum: Kabul edildi (WP38, 28 Tem 2026)
- Karar sahipleri: proje sahibi + uygulama oturumu
- İlgili: ADR-0032 (self-hosted dağıtım), ADR-0023 (PWA/push), ADR-0037
  (kullanıcı hesapları), `docs/planning/project-closure-plan.md` WP38 bölümü

## Bağlam

Self-hosted kurulum bugüne kadar origin kökünü varsayıyordu: PWA manifest'i
`start_url:"/"` ve `scope:"/"` ile yayınlanır, service worker `/sw.js` olarak
kök scope'a kaydedilir, precache listesi kök-mutlak yollar içerir, web
istemcisi `apiBaseUrl` üzerinden `/v1/*` çağrıları yapar ve Caddy tüm route'ları
kökten servis eder. Operatörün gerçek altyapısı ise tek bir public domain'in
arkasında Host catch-all'lı bir nginx (`listen 8080 default_server`) ve
`locations-enabled/*.location.conf` path-prefix include'larıyla çok servis
barındırıyor; uygulama bu yapıya ancak `location ^~ /workspace/` benzeri bir
alt-path olarak monte edilebilir. Kök varsayımı yüzünden bu mümkün değildi.

İki strateji değerlendirildi:

1. **Runtime-config (tek build, her base'de çalışır)**: base path'i de
   `PUBLIC_ORIGIN` placeholder ikamesi gibi açılışta string-rewrite ile işlemek
   veya tüm URL'leri relative kurmak.
2. **Build-time base (build-arg)**: base path'i Vite `base` olarak build'e
   indirmek; origin ikamesi runtime'da kalır.

## Karar

**Hibrit: base path build-time (Vite `base`, docker build-arg), origin
runtime (mevcut placeholder ikamesi).** Gerekçe:

- Product imajı zaten `self-hosted.sh install`/`upgrade` sırasında **lokal
  build** ediliyor; operatörün env'indeki `SELF_HOSTED_BASE_PATH`
  `--build-arg` olarak inebilir. "Tek build her base'de çalışır" özelliğinin
  bu dağıtım modelinde alıcısı yok.
- Vite `base`, asset URL'leri, `import.meta.env.BASE_URL` ve TanStack Router
  `basepath` ile derleyici düzeyinde tutarlıdır. Derlenmiş chunk'larda
  `/assets/…` benzeri stringleri açılışta regex ile yeniden yazmak (strateji 1)
  yanlış-pozitif ikame riski taşır ve kök kurulumun bire bir korunması
  garantisini zayıflatır.
- Boş base ile Vite `base` varsayılanı (`/`) aynen bugünkü çıktıyı üretir; kök
  kurulum build çıktısı değişmez (fail-safe regresyon garantisi).

Bileşen kararları:

1. **Yapılandırma**: `SELF_HOSTED_BASE_PATH` env + `--base-path` bayrağı.
   Normalizasyon: başta `/` zorunlu, sonda `/` yok, boş değer = kök; yalnız
   `[A-Za-z0-9._~-]` ve `/` segmentleri kabul edilir, `//`, `.`/`..` segmenti
   ve `/v1|/healthz|/readyz|/assets` gibi uygulama-rezerve kökleriyle çakışan
   tek-segment değerler preflight'ta fail-closed reddedilir. Değer env
   dosyasında kalıcıdır; base değişikliği yeniden build/upgrade gerektirir ve
   imaj tag'ine base slug'ı eklenir (`persistent-self-hosted-product:<commit>`
   kökte değişmez, base'li kurulumda `<commit>-<slug>`).
2. **Web**: Vite `base = VITE_BASE_PATH + '/'`; router `basepath =
import.meta.env.BASE_URL`; kök-mutlak `href`/`window.location` kullanımları
   ortak `withBase()` yardımcısından geçer. `apiBaseUrl` mevcut
   `https://public-origin.invalid` placeholder'ı ile build edilir ve
   self-hosted web sunucusu açılışta bunu `PUBLIC_ORIGIN + BASE_PATH` ile
   ikame eder; böylece tüm `/v1` çağrıları ve WebSocket (`/v1/realtime`) base
   altından akar. `new URL('/v1/…', apiBaseUrl)` deseni base'i düşürdüğünden
   yasaktır (string birleştirme kullanılır).
3. **PWA**: manifest relative üyelerle yayınlanır (`start_url:"./"`,
   `scope:"./"`, `id:"./"`, relative ikonlar) — manifest hangi base altından
   servis edilirse o scope'a çözülür, kökte davranış aynıdır. `sw.js` tek
   statik dosya kalır ve scope'unu açılışta `new URL('./', self.location)`
   ile türetir; precache/never-cache listeleri ve bildirim hedefleri bu base
   ile kurulur. SW kaydı `BASE_URL + 'sw.js'` üzerinden, scope `BASE_URL`
   olarak yapılır (SW scope kuralı gereği `sw.js` base altından servis edilir).
4. **Sunucu**: self-hosted web SSR sunucusu `BASE_PATH` env'i ile base
   farkındalıdır: statik asset'leri base altından servis eder, SSR'a tam
   path'i geçirir (router basepath eşleşir), tam `BASE_PATH` isteğini
   `BASE_PATH/`'e 308 ile yönlendirir. Caddy control-plane matcher'ı
   `{base}/v1/* {base}/healthz {base}/readyz` yollarını `uri strip_prefix`
   ile control-plane'e taşır; control-plane API yüzeyi kökte kalır (değişmez).
5. **Base dışı istekler**: kök `/{healthz,readyz}` **korunur** (compose
   healthcheck'leri, lifecycle/monitoring scriptleri ve mevcut kurulumlar
   kırılmaz); tam kök `/` isteği `{base}/`'e 308 redirect edilir; diğer tüm
   base dışı yollar web sunucusunda 404'tür. Operatör senaryosunda base dışı
   istekler zaten üstteki nginx'te başka servislere gider.
6. **Kanıt**: `wp38:subpath` sandbox gate'i, pinli Caddy imajıyla operatör
   topolojisinin eşleniği bir dış proxy (Host catch-all + `/workspace/`
   path-prefix, URI strip YOK) arkasında kurulumu doğrular: manifest/SW scope,
   kayıt→login→session→turn API akışı, `/v1/realtime` akışı ve SW offline
   replay davranışı base altında kanıtlanır; kök kurulum regresyonu boş base
   ile `wp32:*` gate'lerinde kalır.

## Sonuçlar

- Kök kurulumlar için build çıktısı ve davranış bire bir korunur; base'li
  kurulum bilinçli bir build-time seçimidir ve env + imaj tag'inde görünürdür.
- Base değişikliği "config değişikliği + restart" değil "upgrade" işlemidir;
  runbook bunu belgeler. Bu, tek build imajıyla çoklu base hedefleyen ileri
  senaryoları (aynı origin'de çoklu instance) kapsam dışında bırakır.
- wp29 imzalı release imajları kök base ile üretilir; subpath operatörü
  kaynaktan (varsayılan yol) kurar.
