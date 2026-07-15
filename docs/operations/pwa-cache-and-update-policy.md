# PWA cache ve güncelleme politikası

## Güvenlik sınırı

Service Worker yalnız aynı origin'deki uygulama kabuğunu ve public statik asset'leri
cache'ler. Son senkronize conversation/history verisi browser `localStorage` alanında
minimum read-only projection olarak tutulur: session başlığı/durumu/model metadata'sı
ile mesaj rolü, metni, sequence ve turn kimliği. Attachment body, private download,
secret, credential, auth/readiness cevabı, event stream ve keyfi API response'u bu
projection'a girmez.

`/v1/`, `/readyz`, `/healthz`, `/events`, `/auth`, `/attachments/` ve `/artifacts/`
istekleri Service Worker tarafından hiç ele alınmaz. `Authorization` taşıyan istekler,
`Cache-Control: private|no-store` response'ları ve `Set-Cookie` içeren response'lar
cache'e yazılmaz. Navigation shell yalnız başarılı, public ve aynı route'a ait HTML
olarak saklanır; statik asset cache'i script, style, font ve image hedefleriyle sınırlıdır.

## Offline davranışı

- Offline açılışta aynı route'un son güvenli shell'i ve minimum conversation/history
  snapshot'ı salt okunur gösterilir.
- Yeni prompt/turn, attachment upload ve mutating conversation/folder kontrolleri açık
  uyarıyla devre dışıdır. Background Sync veya sessiz offline queue yoktur.
- Browser/tab kapanması provider interrupt üretmez. Aktif turn server-owned kalır.
- Bağlantı geri geldiğinde API snapshot'ı alınır; durable sequence high-water cursor'ından
  replay/live geçişi yapılır ve local read-only projection güncellenir.

## Sürüm ve etkinleştirme

Service Worker URL'si ve cache adı aynı WP sürümüyle değiştirilir. Yeni worker install
olduğunda mevcut worker'ı zorla devreden çıkarmaz; waiting durumda kullanıcıya “Yeni
sürüm hazır” bildirimi gösterir. Yalnız kullanıcı `Güncelle` dediğinde `SKIP_WAITING`
mesajı gönderilir ve `controllerchange` sonrasında sayfa yenilenir. Böylece açık UI akışı
beklenmedik anda reload olmaz; reload olsa dahi server-owned turn interrupt edilmez ve
terminal sonuç geri dönüşte replay edilir.

Politika veya cache kapsamı değiştiğinde `serviceWorkerUrl`, `CACHE_VERSION` ve
`pwa-assets.test.ts` birlikte güncellenir. Production kanıtı için:

```sh
pnpm phase2:accept:browser
```

Bu kontrol manifest/ikonları, controlled production worker'ı, desktop/mobil taşmayı,
offline reload/history, gönderim engelini, online high-water replay'i ve browser
error listesini doğrular.
