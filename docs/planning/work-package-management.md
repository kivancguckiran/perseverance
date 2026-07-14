# İş Paketi Yönetim Protokolü

- Belge durumu: Aktif
- Başlangıç tarihi: 14 Temmuz 2026
- Yönetim kaynakları: `docs/planning/poc-implementation-plan.md` ve
  `docs/planning/phase-1-alpha-plan.md`

## Bu task'ın rolü

Bu task kod implementasyonu yapmak yerine Persistent Codex Workspace PoC iş paketlerini yönetir, teslimatları kabul kriterlerine göre değerlendirir ve ilerleme durumunu takip eder.

## Zorunlu çalışma kuralları

1. Her zaman yalnızca bir aktif iş paketi bulunur.
2. Bir iş paketi başlamadan önce başka bir Codex task'ına doğrudan verilebilecek kısa, net, eksiksiz ve uygulanabilir bir prompt hazırlanır.
3. Prompt; hedefi, kapsamı, kapsam dışı maddeleri, beklenen çıktıları ve zorunlu doğrulamaları içerir.
4. Teslimat geldiğinde önce kod, test ve doğrulama kanıtları incelenir.
5. Kabul kriterleri tamamen sağlanmadan iş paketi tamamlandı sayılmaz.
6. Eksik, hatalı veya doğrulanmamış maddeler tek tek yazılır.
7. Eksik varsa yeni iş paketine geçilmez; yalnız mevcut eksikleri kapatan bir düzeltme prompt'u üretilir.
8. İş paketi tamamlandıysa durum açıkça `Tamamlandı` olarak işaretlenir ve yalnız sıradaki paket için yeni uygulama prompt'u hazırlanır.
9. Uygulama task'ının “tamamlandı” beyanı tek başına yeterli kanıt değildir.
10. Doğrulanamayan davranış tamamlanmamış kabul edilir.
11. Her uygulama veya düzeltme task'ı teslimat doğrulamalarını geçirdikten sonra yalnız ilgili iş paketi değişikliklerini tek ve açıklayıcı bir Git commit'inde kaydeder; teslimat raporu commit hash'ini içerir.

## Teslimat değerlendirme formatı

Her değerlendirme şu sırayı izler:

1. **Aktif iş paketi**
2. **Karar:** Tamamlandı / Eksik / Doğrulanamadı
3. **Doğrulanan çıktılar**
4. **Eksikler veya hatalar**
5. **Kanıt:** dosya, test ve komut sonuçları
6. **Verilecek prompt:** sonraki paket veya yalnız düzeltme işi

## Prompt formatı

Uygulama task'ına verilecek prompt şu alanları içerir:

- İş paketi ve hedef
- Yapılacak işler
- Kapsam dışı işler
- Beklenen dosya/çıktılar
- Kabul kriterleri
- Çalıştırılacak doğrulama komutları
- Teslimat raporunda istenecek kanıtlar
- Teslimat sonunda oluşturulacak Git commit'i ve istenecek commit hash'i

## Güncel iş paketi durumu

| İş paketi                                    | Durum                      | Not                                                                                                         |
| -------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| WP0 — Repository ve protokol temeli          | Tamamlandı                 | Generator, sürüm pini, schema hash ve `pnpm verify` doğrulandı                                              |
| WP1 — Workspace Agent process ve RPC köprüsü | Tamamlandı                 | Typed lifecycle hataları, timeout, restart/backoff, crash-loop, health state ve gerçek handshake doğrulandı |
| WP2 — Normalize event adapter                | Tamamlandı                 | Hedef mapping'ler, runtime validation, reconciliation, redaction/checksum ve golden fixture'lar doğrulandı  |
| WP3 — Session, event store ve replay         | Tamamlandı                 | Atomik ingest, durable session/event store ve boşluksuz high-water replay/live geçişi doğrulandı            |
| WP4 — Gerçek thread ve turn akışı            | Tamamlandı                 | Restart-safe ingest, collision guard, observable delivery error ve iki-instance browser akışı doğrulandı    |
| WP5 — Approval state machine                 | Tamamlandı                 | Durable state machine, concurrent karar, gerçek smoke ve responsive approval UI doğrulandı                  |
| WP6 — Resume, reconnect ve recovery          | Tamamlandı                 | Kalıcı home, aynı-thread resume, recovery, steer/interrupt ve session route doğrulandı                      |
| WP7 — Büyük çıktı ve timeline dayanıklılığı  | Tamamlandı                 | Uçtan uca bounded output, redakte artifact, backpressure ve responsive timeline doğrulandı                  |
| WP8 — Golden senaryolar ve PoC demosu        | Tamamlandı                 | Üç gerçek golden görev, dört arıza senaryosu, cleanup ve responsive browser kabulü doğrulandı               |
| WP9 — Alfa başlatma ve auth bootstrap        | Tamamlandı                 | Güvenli provisioning, readiness ve actionable auth recovery bağımsız olarak doğrulandı                      |
| WP10 — Workspace ve Git görünürlüğü          | Tamamlandı                 | Scoped session navigasyonu, durable Git snapshot ve responsive salt-okunur yüzey doğrulandı                 |
| WP11 — Audit ve temel metrics                | Tamamlandı                 | Atomik durable audit, dinamik readiness, bounded metrics ve contention davranışı doğrulandı                 |
| WP12 — Alfa hardening ve kabul               | Uygulandı / kabul bekliyor | Tek kiracılı alfa runbook, soak/canary ve release gate                                                      |

## WP1 nihai denetim sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- App-server child process başlatılıyor.
- stdout JSONL ve stderr ayrılmış.
- Correlation ID ile request/response eşleniyor.
- Notification ve server request listener'ları mevcut.
- Fake server initialize testi geçiyor.
- Gerçek Codex `0.144.2` initialize smoke testi geçti.
- Process exit bütün pending request'leri typed `ProcessExitedError` ile reddediyor ve map'i temizliyor.
- Malformed JSON fatal `ProtocolError` üretiyor; otomatik restart yapılmıyor.
- Yapılandırılabilir request timeout `RequestTimeoutError` üretiyor ve pending kaydı temizliyor.
- Beklenmeyen exit exponential backoff ile restart ediliyor ve initialize handshake tekrarlanıyor.
- Pencere bazlı crash-loop limiti aşıldığında health state `failed` oluyor.
- Graceful stop restart oluşturmuyor.
- Dışarı okunabilir `stopped`, `starting`, `initializing`, `ready`, `restarting`, `failed` health state'leri mevcut.

Doğrulama kanıtı:

- `pnpm verify`: başarılı.
- Vitest: 4 test dosyası, 13 test başarılı.
- `pnpm --filter @persistent-codex/workspace-agent smoke:real`: gerçek Codex `0.144.2` initialize handshake başarılı.

## WP2 nihai denetim sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Versioned ve Zod ile doğrulanan normalize timeline event sözleşmeleri mevcut.
- Agent message, reasoning summary, plan, command, file change/diff, MCP/dynamic tool, approval, token usage, error ve compaction olayları generated Codex sözleşmelerinden normalize ediliyor.
- Bilinmeyen method, item ve ileri uyumlu enum değerleri `codex.unknown` olarak korunuyor.
- Bilinen method'un geçersiz parametreleri typed `CodexEnvelopeValidationError` üretiyor.
- Delta birikimi `(threadId, turnId, itemId)` bileşik anahtarıyla izole ediliyor; completed snapshot yetkili son durum oluyor ve yinelenen completion idempotent kalıyor.
- Yapılandırılabilir redaction checksum'dan önce uygulanıyor; canonical SHA-256 deterministik ve fixture çıktısına secret sızmıyor.
- On golden JSONL fixture çifti normalize semantiği, deterministik ID/zaman/sequence ve domain parse uyumluluğunu doğruluyor.
- Approval olayları yalnız normalize ediliyor; karar/persistence davranışı sonraki paketlere taşınmamış.

Doğrulama kanıtı:

- `pnpm verify`: başarılı.
- Vitest: 4 test dosyası, 31 test başarılı.
- Typecheck ve TanStack Start client/SSR production build başarılı.

## WP3 nihai denetim sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Session kayıtları tenant/workspace/session scope'uyla saklanıyor; Codex thread binding aynı değer için idempotent, farklı değer için conflict-safe.
- Workspace sequence tahsisi `BEGIN IMMEDIATE` transaction içinde yapılıyor; raw event, normalize event, session cursor ve sequence birlikte commit veya rollback oluyor.
- Duplicate `ingestKey` ikinci raw event, normalize event veya sequence üretmiyor; checksum tek başına dedupe anahtarı olarak kullanılmıyor.
- Redakte inline raw event ve artifact pointer seçenekleri ile idempotency key kayıtları durable SQLite şemasında mevcut.
- REST replay scope kontrollü, sequence sıralı, limitli ve `highWaterSequence`, `nextAfterSequence`, `hasMore` metadata'sı üretiyor.
- Paylaşılan Zod REST/WebSocket sözleşmeleri subscribe, replay, subscribed, event, ack ve error mesajlarını doğruluyor.
- WebSocket high-water replay sırasında commit edilen live event'leri connection-local buffer'a alıyor; replay sonrasında sıralı ve duplicate olmadan gönderiyor.
- Ack cursor scope kontrollü, monoton ve son gönderilen sequence ile sınırlı.
- File-backed reopen, legacy migration, rollback, isolation, duplicate ingest, reconnect ve replay/live yarış testleri mevcut.

Doğrulama kanıtı:

- `pnpm verify`: başarılı.
- Vitest: 4 test dosyası, 46 test başarılı.
- Bütün workspace package typecheck'leri ve TanStack Start client/SSR production build başarılı.

WP4 ilk kabul denetiminde düzeltmeye gönderilmiştir.

## WP4 ilk kabul denetimi — düzeltme gerekli (kapatıldı)

Karar: **Eksik**

Doğrulananlar:

- Workspace runtime registry, session/turn endpoint'leri, idempotency coalescing/conflict davranışı ve notification→adapter→store→WebSocket hattı uygulanmış.
- `pnpm verify` başarılı; 4 test dosyasında 53 test geçti ve client/SSR build tamamlandı.
- Gerçek Codex `0.144.2` smoke akışı gerçek thread ve turn ID'leriyle final `TAMAM` mesajını aldı.
- Browser sayfayı hatasız açtı, gerçek session/thread oluşturdu ve gerçek turn tamamlandı.

Eksik/hatalı davranış:

- Runtime `ingestKey` değeri yalnız `workspaceId:processGeneration:receiveOrdinal` kullanıyor. Control-plane/runtime yeniden başladığında generation ve ordinal yeniden `1` olduğu için önceki durable kayıtlarla çakışıyor.
- Event store, aynı ingest key farklı session veya checksum ile geldiğinde conflict üretmek yerine önceki session event'ini duplicate kabul ediyor.
- Gerçek browser turn'ünde ilk 20 transport mesajı önceki session anahtarlarıyla çakışarak kayboldu. Yeni session yalnız sequence 22–25 olaylarını aldı ve final kart beklenen `TARAYICI_TAMAM` yerine son delta parçası `AM` olarak kaldı.
- Runtime delivery hataları queue içinde sessizce yutuluyor; adapter/store teslimat hatası control-plane tarafından gözlemlenemiyor.

Kanıt:

- SQLite `raw_events` kayıtlarında önceki session `wsp_local:1:2`–`wsp_local:1:23` anahtarlarını kullanırken yeni session yalnız daha önce kullanılmamış `wsp_local:1:24`, `:26`, `:27` anahtarlarını yazabildi.
- Yeni session event listesi yalnız `agent.message.delta: "AM"`, token usage, unknown status ve `turn.completed` içerdi; authoritative `agent.message.completed` yoktu.
- Browser console ve error overlay temiz olmasına rağmen timeline final içeriği eksikti.

Bu bulgular aşağıdaki nihai yeniden denetimde kapatılmıştır.

## WP4 nihai yeniden denetim sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Her registry runtime'ı injectable factory/default `randomUUID` ile benzersiz `runtimeInstanceId` alıyor; child-process generation değişse de runtime kimliği sabit, yeni control-plane instance'ında farklı.
- `ingestKey`; tenant, workspace, runtime instance, process generation ve receive ordinal alanlarını içeriyor.
- Aynı ingest key yalnız aynı session ve checksum için duplicate kabul ediliyor; farklı session/checksum atomik `INGEST_KEY_CONFLICT` üretiyor ve sequence/row oluşturmuyor.
- Delivery handler hatası callback ve structured control-plane log'una aktarılıyor; queue sonraki mesajlarla devam ediyor.
- File-backed regression testi aynı DB üzerinde iki control-plane instance'ı, 12 unique/monotonic sequence ve iki authoritative final event'i doğruluyor.
- Bağımsız gerçek restart/browser audit'inde ilk session sequence 1–27, ikinci session 28–55 aralığında kaldı; runtime UUID'leri farklıydı.
- SQLite'da ilk final `BIRINCI_TAM_MESAJ` sequence 24, restart sonrası ikinci final `IKINCI_RESTART_TAM_MESAJ` sequence 52 olarak `agent.message.completed` kaydedildi.
- Browser ikinci authoritative finali ve `turn.completed` olayını gösterdi; console warning/error ve Vite overlay yoktu.
- 390×844 görünümünde yatay taşma veya error overlay oluşmadı.

Doğrulama kanıtı:

- `pnpm verify`: başarılı.
- Vitest: 4 test dosyası, 56 test başarılı.
- Bütün package typecheck'leri ve TanStack Start client/SSR production build başarılı.
- `pnpm --filter @persistent-codex/workspace-agent smoke:real-flow`: gerçek Codex final mesajı `TAMAM`.
- Uygulama commit'i: `81b6881` (`feat: complete persistent Codex workspace through WP4`).

Aktif iş paketi WP5'tir.

## WP5 ilk kabul denetimi — düzeltme gerekli

Karar: **Eksik**

Doğrulananlar:

- Durable approval schema, atomik raw+normalize+approval ingest, optimistic version kontrolü, REST karar endpoint'i, scoped WebSocket approval mesajı ve responsive approval kartı için uygulama adayı mevcut.
- `pnpm verify` başarılı: 5 test dosyasında 59 test geçti; typecheck ile TanStack Start client/SSR build tamamlandı.
- Gerçek Codex `0.144.2` approval smoke'u command approval request'i aldı, bir `decline` response gönderdi ve terminal turn durumuna ulaştı.
- Smoke geçici izole `CODEX_HOME` kullandı ve dizinin temizlendiği bağımsız olarak doğrulandı.
- Uygulama desktop ve 390×844 görünümde yatay taşma, console warning/error veya overlay olmadan açıldı.

Eksik/hatalı davranış:

- WP5 değişiklikleri commit edilmemiş; zorunlu `feat: add durable approval state machine` commit'i yok ve çalışma ağacı dirty.
- Gerçek approval smoke doğrudan `CodexAppServerClient.respond()` çağırıyor; control-plane durable approval kaydını, pending REST sorgusunu, decision endpoint'ini, CAS/idempotency akışını ve tek upstream response'u uçtan uca kanıtlamıyor. `responseBeforeDecision` alanı gerçek bir ölçüm yerine sabit `false` yazılıyor.
- File approval için integration testi ve aynı session/turn/item kapsamından diff context lookup uygulanmamış; context her zaman `diff: null` oluyor.
- UI command actions ve redakte network context'i göstermiyor; eski “WP5’e kadar yalnızca pasif kayıt” metni korunmuş.
- UI yalnız `pending`/`resolving` kayıtları render ettiği için WebSocket ile gelen `resolved`, `expired` veya `superseded` durum kartı anında kayboluyor; karar sonucu kullanıcıya canlı olarak gösterilmiyor.
- Zorunlu file/command dört karar mapping'i, gerçek concurrent decision yarışı, generation/runtime mismatch, turn completion/interrupt/crash expiry, `serverRequest/resolved` reconciliation, redaction, approval WebSocket lifecycle/reconnect ve UI interaction testleri eksik.
- Process crash/generation değişiminde pending approval'ları proaktif expire eden lifecycle bağlantısı ve buna ait crash/recovery testi bulunmuyor.

WP5 tamamlanmadan WP6 aktif edilemez.

## WP5 kabul düzeltmesi — yeniden denetim bekliyor

Durum: **Aktif / kabul bekliyor**

Düzeltme teslimatında gerçek smoke control-plane REST hattına taşındı; command/file context, diff lookup, runtime health/generation expiry, resolved reconciliation, WebSocket lifecycle ve terminal approval kartları eklendi. Integration matrisi command/file karar mapping'i, concurrent CAS, idempotency, isolation, lifecycle, redaction ve reconnect davranışını kapsayacak biçimde genişletildi. Gerçek smoke pending REST kaydı, karar öncesi sıfır response, decision endpoint'i sonrası tek response, durable resolved durum ve terminal turn gözlemini kanıtladı. Çalışan uygulama gerçek controlled approval ile desktop ve 390×844 görünümde doğrulandı.

Bu kayıt WP5'i tamamlandı yapmaz; nihai karar yönetici yeniden denetimindedir.

## WP5 nihai yeniden denetim sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Approval kaydı raw envelope ve normalize event ile aynı transaction'da durable oluşuyor; tenant/workspace scope, optimistic locking ve idempotency korunuyor.
- Generated command ve file approval istekleri ile dört public karar mapping'i test ediliyor; concurrent iki karardan yalnız biri upstream `respond` üretiyor.
- File approval context'i aynı session/turn/item içindeki proposal/diff event'lerinden bulunuyor; bulunamayan diff açıkça unavailable kalıyor ve hassas command context'i redakte ediliyor.
- Runtime health kaybı, process generation değişimi ve terminal/interrupted turn pending approval'ları expire veya supersede ediyor; `serverRequest/resolved` ikinci response üretmeden reconcile ediliyor.
- WebSocket pending→resolving→resolved/expired lifecycle'ını yayınlıyor; REST reconnect sonrası durable reconciliation sağlıyor.
- `pnpm verify` başarılı: 5 test dosyasında 65 test geçti; bütün package typecheck'leri ve TanStack Start client/SSR build tamamlandı.
- Gerçek Codex `0.144.2` control-plane smoke'unda durable pending kayıt, karar öncesi 0 response, REST `decline` sonrası tam 1 response, resolved kayıt ve terminal turn doğrulandı; geçici Codex home ve SQLite DB temizlendi.
- Bağımsız browser denetiminde gerçek command approval kartı pending context ve karar butonlarıyla göründü; `Decline` sonrası resolved kart ekranda kaldı ve turn tamamlandı.
- 390×844 görünümünde yatay taşma, console warning/error veya error overlay yoktu.
- Uygulama commit'i: `82e1de1` (`feat: add durable approval state machine`).

Aktif iş paketi WP6'dır.

## WP6 ilk kabul denetimi — düzeltme gerekli

Karar: **Eksik**

Doğrulananlar:

- Server-owned hash tabanlı persistent Codex home adayı, durable recovery alanları, session detail/resume API'si, generated `thread/read` → `thread/resume`, steer/interrupt endpoint'leri ve adreslenebilir session route'u uygulanmış.
- `pnpm verify` başarılı: 6 test dosyasında 69 test geçti; typecheck ve TanStack Start client/SSR build tamamlandı.
- Fake runtime testinde aynı-key concurrent resume coalesce ediliyor ve `THREAD_NOT_RESUMABLE` thread binding'i değiştirmeden durable `recovery_required` durumu üretiyor.

Eksik/hatalı davranış:

- WP6 değişiklikleri staged fakat commit edilmemiş; zorunlu `feat: add session resume and recovery` commit'i yok ve çalışma ağacı temiz değil.
- Gerçek iki-instance app-server restart/resume smoke komutu ve kanıtı bulunmuyor.
- Persistent home auth/config provisioning uygulanmamış; yeni home yalnız boş dizin oluşturuyor. Gerçek authenticated turn ve resume davranışı kanıtlanmamış.
- `thread/read`/`thread/resume` snapshot'larındaki eksik authoritative completed item/turn event'lerini event store ile reconcile eden kod yok; yalnız aktif turn belleği yeniden kuruluyor.
- WP6 test kapsamı yalnız iki control-plane resume testi ve iki home testi ekliyor. Runtime crash/generation auto-resume, schema v2→v3 migration, pending idempotency crash-window, snapshot dedupe/reconciliation, steer, interrupt, approval expiry, session isolation ve browser reload/reconnect testleri eksik.
- Interrupt'ın crash penceresinde duplicate upstream etkiyi engelleyen durable idempotency kaydı yok.
- Bütün `thread/read`/`thread/resume` hataları transient runtime/auth/timeout ayrımı yapılmadan `THREAD_NOT_RESUMABLE` olarak kalıcılaştırılıyor.
- API `recoveryOptions` döndürse de UI yalnız retry resume butonu gösteriyor; `start_new_session` ve `view_read_only` seçenekleri recovery bağlamında sunulmuyor.
- Browser reload, WebSocket reconnect, aynı thread'de ikinci turn, steer/interrupt ve 390×844 recovery UI bağımsız olarak doğrulanmamış.
- Teslimata ait dev server process'leri 3000 ve 3100 portlarında çalışır durumda bırakılmış; geçici kaynak cleanup tamamlanmamış.

WP6 tamamlanmadan WP7 aktif edilemez.

## WP6 ilk düzeltme yeniden denetimi — runtime UI düzeltmesi gerekli

Karar: **Eksik**

Kapatılan ilk denetim maddeleri:

- `2d7f3ac` commit'i oluşturuldu ve çalışma ağacı temizdi.
- `pnpm verify` başarılı: 6 test dosyasında 78 test geçti; typecheck ve production build tamamlandı.
- Persistent home provisioning, schema v2→v3 migration, crash-window idempotency, snapshot reconciliation/dedupe, typed transient recovery, steer/interrupt ve runtime generation recovery testleri eklendi.
- Gerçek iki-instance restart smoke aynı thread ID'yi resume etti; sequence 22'den 43'e ilerledi, tekrar resume duplicate snapshot üretmedi ve geçici DB/home temizlendi.

Kalan kabul engeli:

- Gerçek dev/SSR başlangıcında `/` endpoint'i HTTP 500 döndü. `apps/web/src/routes/sessions.$sessionId.tsx`, index route modülünü import ederek circular route bağımlılığı oluşturuyor ve runtime'da `ReferenceError: SessionPage is not defined` üretiyor.
- Bu nedenle session URL reload, recovery UI, steer/interrupt kontrolleri ve 390×844 browser akışı bağımsız olarak doğrulanamadı. Mevcut build kontrolü route modülünü gerçek SSR request'iyle execute etmediği için hatayı yakalamıyor.

WP6 aktif kalır; WP7'ye geçilemez.

## WP6 runtime UI düzeltmesi — yeniden denetim bekliyor

Durum: **Aktif / kabul bekliyor**

Session route, index route component'ini modül yükleme anında okumak yerine render
zamanında çözen bir wrapper kullanacak biçimde düzeltildi. Gerçek dev/SSR
başlangıcında `/` ve `/sessions/:sessionId` HTTP 200 döndürdü; session sayfası
browser reload sonrasında console warning/error veya overlay olmadan render edildi.
390×844 görünümünde yatay taşma oluşmadı. `pnpm verify` ve gerçek iki-instance
restart/resume smoke yeniden geçti.

Bu kayıt WP6'yı tamamlandı yapmaz; nihai karar yönetici yeniden denetimindedir.

## WP6 ikinci düzeltme yeniden denetimi — yapısal route/test düzeltmesi gerekli

Karar: **Eksik**

Doğrulananlar:

- `f7e3bac` commit'i mevcut ve çalışma ağacı temiz.
- `pnpm verify` başarılı: 6 test dosyasında 78 test geçti; typecheck ve production build tamamlandı.
- Bağımsız gerçek dev/SSR kontrolünde `/` ve `/sessions/test-session` HTTP 200 döndü; önceki `SessionPage is not defined` runtime hatası artık oluşmadı.
- Önceki yeniden denetimde gerçek iki-instance restart/resume smoke aynı thread, monotonic sequence ve snapshot dedupe davranışını kanıtladı.

Kalan kabul engeli:

- `apps/web/src/routes/sessions.$sessionId.tsx` hâlâ `./index` route modülünü import ediyor. İstenen route-olmayan ortak `WorkspacePage` component ayrımı yapılmadı; circular route bağımlılığı yalnız değer okuması render zamanına ertelenerek maskelendi.
- `/` ve `/sessions/:sessionId` route'larını gerçek SSR HTTP request'iyle execute eden otomatik regresyon testi eklenmedi. Bu nedenle `pnpm verify`, ilk bulunan runtime 500 sınıfındaki hatayı gelecekte yine yakalayamaz.

WP6 aktif kalır; WP7'ye geçilemez.

## WP6 yapısal route/test düzeltmesi — yeniden denetim bekliyor

Durum: **Aktif / kabul bekliyor**

Ortak `WorkspacePage`, route modülleri dışındaki `apps/web/src/workspace-page.tsx`
dosyasına taşındı. `/` ve `/sessions/:sessionId` route'ları artık birbirini import
etmeden bu component'i kullanıyor. `pnpm verify` kapsamına gerçek Vite HTTP server
üzerinden iki route'a request gönderen ve HTTP 200, beklenen SSR gövdesi ile runtime
error yokluğunu doğrulayan regresyon smoke'u eklendi.

Bu kayıt WP6'yı tamamlandı yapmaz; nihai karar yönetici yeniden denetimindedir.

## WP6 üçüncü düzeltme yeniden denetimi — route param düzeltmesi gerekli

Karar: **Eksik**

Doğrulananlar:

- `86b5fa4` commit'i mevcut ve çalışma ağacı denetim başlangıcında temizdi.
- Ortak `WorkspacePage`, route modülleri dışına taşındı; `/` ve
  `/sessions/:sessionId` route'ları artık birbirini import etmiyor.
- `pnpm verify` içindeki format, typecheck, 6 test dosyasında 78 test ve production
  build adımları geçti. Localhost bind izniyle ayrıca çalıştırılan gerçek Vite HTTP
  smoke'u her iki route için HTTP 200 ve beklenen SSR gövdesini doğruladı.

Kalan kabul engeli:

- Session route TanStack Router'ın `$sessionId` parametresini ortak component'e
  aktarmıyor. `WorkspacePage` session kimliğini hâlâ mount sonrasında
  `window.location.pathname` regex'iyle çıkarıyor. Önceki düzeltme prompt'unda açıkça
  istenen route-param/prop sınırı ve `window` path parsing yasağı karşılanmadı.
- Mevcut SSR smoke yalnız HTML/status kontrol ediyor; session parametresinin doğru
  session detail isteğine aktarıldığını kanıtlamıyor. Parametre aktarımı component veya
  browser/integration testiyle regresyon kapsamına alınmalıdır.

WP6 aktif kalır; WP7'ye geçilemez.

## WP6 nihai yeniden denetim sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- `86b5fa4` ana uygulama commit'i ile `45e73ef` route-param düzeltme commit'i mevcut.
- Server-owned persistent Codex home, auth/config provisioning, schema v2→v3 migration,
  durable recovery alanları ve transient/terminal recovery ayrımı uygulanmış.
- Gerçek iki-instance restart smoke aynı Codex thread'ini resume etti; sequence ilerledi,
  tekrar resume authoritative snapshot'ı duplicate etmedi ve geçici kaynaklar temizlendi.
- Runtime generation recovery, crash-window idempotency, snapshot reconciliation/dedupe,
  steer, interrupt, approval expiry ve tenant/session isolation testleri mevcut.
- Session route `$sessionId` değerini `Route.useParams()` ile alıp ortak
  `WorkspacePage` component'ine prop olarak aktarıyor. URL parsing ve route-to-route
  import bulunmuyor; session oluşturma TanStack navigation kullanıyor.
- `pnpm verify` kapsamındaki format, typecheck, 7 test dosyasında 81 test ve production
  build geçti. Localhost izniyle gerçek Vite HTTP smoke'u `/` ile
  `/sessions/:sessionId` için HTTP 200 doğruladı.
- Bağımsız browser reload denetiminde `route-param-test`, tam olarak scoped session
  detail isteğine aktarıldı. Desktop ve 390×844 görünümünde console warning/error,
  Vite overlay veya yatay taşma oluşmadı.
- Denetim için başlatılan web/control-plane süreçleri ve browser tab'ları kapatıldı.

Uygulama commit'leri: `86b5fa4` (`feat: add session resume and recovery`) ve
`45e73ef` (`fix: use TanStack session route params`).

Aktif iş paketi WP7'dir.

## WP7 ilk kabul denetimi — uçtan uca bounded-output düzeltmesi gerekli

Karar: **Eksik**

Doğrulananlar:

- `60c71e1` (`feat: add bounded output and timeline resilience`) commit'i mevcut ve
  denetim başlangıcında çalışma ağacı temizdi.
- ADR-0007, shared artifact/event/realtime sözleşmeleri, schema v4 artifact tablosu,
  filesystem-backed storage, scoped metadata/download route'u, 64 KiB preview tail,
  2.000 event UI penceresi ve TanStack virtualizer uygulama adayı mevcut.
- Artifact storage testi 100 MiB veriyi 64 KiB chunk'larla yazarak bounded tail,
  byte count, SHA-256, duplicate chunk ve basit secret redaction davranışını doğruluyor.
- `pnpm verify` kapsamındaki format, typecheck, 8 test dosyasında 84 test ve production
  build geçti. Localhost izniyle ayrıca çalıştırılan SSR HTTP smoke'u iki route için
  başarılı oldu.

Kalan kabul engelleri:

- 100 MiB doğrulaması yalnız `LocalArtifactStorage` katmanını çalıştırıyor; gerçek
  adapter → orchestrator → event store → artifact API → realtime → browser hattını
  kanıtlayan controlled smoke yok.
- Adapter tek bir upstream delta 64 KiB'ı aştığında yalnız son tail'i event'e koyuyor;
  orchestrator artifact'e bu kesilmiş `event.payload.text` değerini append ediyor.
  Deltası olmayan büyük completed snapshot'ta da yalnız preview tail yazılıyor. Bu iki
  durumda tam artifact eksik, total byte/checksum semantiği hatalıdır.
- Redaction streaming değildir; chunk sınırına bölünen credential kaçabilir. Ayrıca raw
  envelope redaction hook'u credential içeren string'in tamamını `[REDACTED]` yaparak
  secret dışındaki çıktıyı da kaybediyor. Uçtan uca tam redakte çıktı kanıtlanmamıştır.
- Artifact download sunucuda `readFileSync`, web istemcisinde `response.blob()` kullanıp
  tam dosyayı belleğe alıyor. Büyük artifact için bounded server/browser bellek ve
  streaming/range kabulü karşılanmıyor.
- Realtime limitleri yalnız replay/live sınırındaki geçici buffer'a uygulanıyor. Canlı
  `socket.send` hattında outbound queue, `bufferedAmount`/drain kontrolü veya slow-consumer
  politikası yok; `slow_consumer` durumu üretilemiyor ve test edilmemiş.
- Browser event Map'i 2.000 kayıtla sınırlı olsa da 1.600 × 64 KiB delta yaklaşık tam
  100 MiB metni bellekte tutabiliyor. Command deltaları state içinde coalesce edilmediği
  için 100 MiB browser kabulü kanıtlanmıyor.
- Schema v4 `artifacts` tablosu için persistence API/call bulunmuyor; metadata yalnız
  filesystem JSON'unda kalıyor. v3→v4 metadata migration/reopen testi yok.
- Artifact API metadata/range/header/isolation, orchestrator spill/dedupe/completed,
  crash/finalize recovery, gerçek orphan cleanup, symlink escape, slow consumer/resync,
  UI bounded tail/artifact/virtualization testleri eklenmemiş. Browser doğrulama kanıtı
  da teslimatta bulunmuyor.

WP7 aktif kalır; WP8'e geçilemez.

## WP7 nihai yeniden denetim sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- `e450689` (`fix: complete WP7 bounded output pipeline`) düzeltme commit'i mevcut;
  önceki kabul engellerini adapter, orchestrator, event store, artifact storage,
  realtime sender ve web state katmanlarında birlikte kapatıyor.
- Kontrollü 100 MiB delta akışı adapter → orchestrator → SQLite artifact metadata →
  filesystem artifact hattından geçiyor; ayrıca deltası olmayan 100 MiB completed
  snapshot tam çıktı, byte count ve SHA-256 ile ayrı regresyon testine sahip.
- Command preview 64 KiB ile sınırlı; raw büyük çıktı transient spill alanıyla raw/event
  satırlarına inline yazılmadan streaming redaction ve 64 KiB storage chunk'larıyla
  artifact'e aktarılıyor. Chunk sınırına bölünen bearer, `sk-`, `sess-` ve structured
  credential örnekleri sızıntısız doğrulandı.
- Artifact metadata tenant/workspace scope'uyla SQLite'da kalıcı; startup reconciliation,
  `recovery_required`, reopen, range response, opaque tek kullanımlık download grant,
  symlink/traversal reddi ve stream download testleri mevcut.
- Canlı WebSocket outbound kuyruğu event/byte sınırına ve `bufferedAmount` kontrolüne
  sahip; yavaş tüketici tek typed `resync` mesajıyla durable cursor'dan toparlanıyor.
- Browser command delta state'i item başına coalesce edilerek 1.600 × 64 KiB girişte
  tek 64 KiB tail olarak kalıyor; uzun timeline sanallaştırılıyor ve sona git kontrolü
  erişilebilir.
- `pnpm verify` kapsamındaki format, bütün package typecheck'leri, 9 test dosyasında
  94 test ve production build geçti. Sandbox dışında SSR HTTP smoke'u `/` ile
  `/sessions/:sessionId` için başarılı oldu.
- Bağımsız browser denetiminde control plane bağlantısı desktop 1280×720 ve mobil
  390×844 görünümünde kuruldu; yatay taşma, console warning/error veya Vite overlay
  oluşmadı. Geçici dev süreçleri ve browser tab'ları kapatıldı.

Uygulama commit'leri: `60c71e1` (`feat: add bounded output and timeline resilience`) ve
`e450689` (`fix: complete WP7 bounded output pipeline`).

Aktif iş paketi WP8'dir. WP8 tamamlanmadan yeni bir iş paketi açılamaz; mevcut Faz 0
planında WP9 tanımlı değildir.

## WP8 uygulama teslimatı — kabul bekliyor

Durum: **Uygulandı / kabul bekliyor**

- `pnpm demo:smoke` dört arıza regresyonunu; üç `pnpm demo:golden:*` komutu gerçek
  app-server görevlerini redakte ve geçici workspace'lerde çalıştırır.
- Read-only final, değişiklik + hedefli test + diff ve pending → concurrent karar →
  resolved approval semantiği durable control-plane replay'inden doğrulanır.
- WebSocket reconnect regresyonu boşluksuz/duplicate'siz cursor replay'ini; gerçek
  recovery smoke'u app-server kapanışı sonrasında aynı thread resume'unu doğrular.
- Unknown fixture gerçek event store/REST replay hattında `codex.unknown` kalır.
- Temiz kurulum, browser desktop/390×844 kontrolü, cleanup ve troubleshooting
  `docs/demo/poc-demo.md` içinde belgelenmiştir.

Bu kayıt WP8'i `Tamamlandı` yapmaz; bağımsız kabul denetimi ve teslimat commit'i
sonrasında nihai karar verilecektir.

## WP8 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `7e1d913` mevcut ve çalışma ağacı temizdir.
- Pinli Codex 0.144.2 generator'ı iki ardışık çalışmada generated drift üretmemiştir.
- Format, bütün package typecheck'leri, 9 test dosyasında 94 test, production build ve
  `/` ile `/sessions/:sessionId` SSR HTTP smoke'u geçmiştir.
- `pnpm demo:smoke`; 54 hedefli testi, unknown event'in event store → REST replay
  hattında `codex.unknown` kalmasını ve gerçek iki-instance aynı-thread recovery'yi
  doğrulamıştır.
- Üç gerçek golden görevde read-only fixture bütünlüğü; file change, diff ve exit code
  0 hedefli test; approval requested → resolved lifecycle'ı, `200/409` yarışı ve tam
  bir upstream response doğrulanmıştır.
- Golden timeline sequence'leri boşluksuz/monoton, event ID'leri benzersiz ve bütün
  geçici process/store/workspace/Codex home cleanup sonuçları `true` olmuştur.
- Bağımsız browser denetiminde session route ve canlı timeline desktop 1280×720 ile
  mobil 390×844 görünümünde yatay taşma, console warning/error veya overlay olmadan
  açılmış; denetim tab'ları ve dev process'leri kapatılmıştır.

Uygulama commit'i: `7e1d913` (`feat: complete WP8 golden PoC demo`).

Faz 0 tamamlandı. Mevcut planda WP9 tanımlı değildir; yeni paket ancak Faz 1 kapsamı
kararlaştırıldıktan sonra açılabilir.

## Faz 1 plan aktivasyonu

Faz 1 tek kiracılı alfa planı `docs/planning/phase-1-alpha-plan.md` içinde WP9–WP12
olarak tanımlandı. Faz 0'da tamamlanan supervisor, replay/resume, WebSocket, artifact ve
responsive timeline kapsamları tekrarlanmadı. Aktivasyon anında WP9 tek aktif paket,
WP10–WP12 ise bağımlılık sırasıyla bekleyen paketlerdi.

## WP9 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `66523dc` (`feat: add alpha auth bootstrap and readiness`) mevcut
  ve kabul öncesinde çalışma ağacı temizdi.
- Alfa preflight; pinli Codex sürümü, canonical workspace/runtime yolları, tüm path
  bileşenlerinde symlink escape, yazılabilir store/artifact kökleri ve allowlist'li
  credential provisioning kontrollerini kapsıyor.
- Generated `account/read` protokolüyle auth readiness doğrulanıyor; auth tekrarları tek
  actionable `AUTH_REQUIRED` recovery sonucunda birleştiriliyor ve auth dışı reconnect
  davranışı korunuyor.
- Credential bulunmayan gerçek smoke, `setup_required` ve `codex login` yönlendirmesini
  secret/path sızdırmadan üretip session başlangıcını engelledi; geçerli lokal Codex
  login'iyle gerçek app-server turn'ü `TAMAM` sonucuyla tamamlandı.
- `pnpm verify`; format, bütün package typecheck'leri, 10 test dosyasında 102 test,
  production build ve sandbox dışında `/` ile `/sessions/:sessionId` SSR HTTP smoke'unu
  başarıyla tamamladı.
- Desteklenen `pnpm alpha:dev` komutuyla readiness endpoint'i `200` döndü; web yüzeyinde
  `Codex auth hazır` durumu ve etkin session kontrolü görüldü. Desktop 1280×720 ve mobil
  390×844 denetimlerinde yatay taşma veya console warning/error oluşmadı.
- Geçici browser tab'ları ve geliştirme süreçleri kapatıldı.

Uygulama commit'i: `66523dc` (`feat: add alpha auth bootstrap and readiness`).

Aktif iş paketi WP10'dur ve uygulama teslimi bağımsız kabul beklemektedir. WP10
tamamlanmadan WP11'e geçilemez.

## WP10 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `3a41ac5` (`feat: add alpha workspace and Git visibility`)
  mevcut ve kabul başlangıcında çalışma ağacı temizdi.
- Workspace Agent Git okuyucusu yalnız sabit salt-okunur `execFile` komutları,
  canonical server-owned cwd, timeout ve output limitleri kullanıyor; API cwd, keyfi
  argüman veya mutation kabul etmiyor.
- Clean/dirty, staged/unstaged/untracked, rename, binary, no-repo, worktree, submodule
  ve symlink fixture'ları; scoped session pagination ve snapshot reopen/idempotency
  testleri geçti.
- Turn öncesi/sonrası snapshot'lar session ve turn kapsamıyla durable saklanıyor;
  bounded diff preview sınırı 64 KiB ve büyük diff scoped `git-diff` artifact hattına
  taşınıyor.
- Tam test koşusunda 11 test dosyasında 109 test geçti; bütün package typecheck'leri,
  production build ve sandbox dışında `/` ile `/sessions/:sessionId` SSR HTTP smoke'u
  başarılı oldu.
- İzole gerçek Codex change golden akışı file change, diff, iki başarılı command ve
  terminal turn üretti; workspace, process, SQLite, artifact ve geçici Codex home
  cleanup sonuçlarının tamamı başarılıydı.
- Desteklenen alfa akışında iki session oluşturuldu; yakın session listesinden önceki
  session'a dönüldü ve Git snapshot refresh/reload sonrasında branch, HEAD, clean durum,
  sınırlı log ve diff görünümü korundu.
- Desktop 1280×720 ve mobil 390×844 denetimlerinde Git/session yüzeyi yatay taşma,
  Vite overlay veya console warning/error üretmedi; browser tab'ları ve geliştirme
  süreçleri kapatıldı.

Uygulama commit'i: `3a41ac5` (`feat: add alpha workspace and Git visibility`).

WP11 uygulanmış ve bağımsız kabul beklemektedir. WP11 tamamlanmadan WP12'ye geçilemez.

## WP11 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `5a9b6c4` ve kabul engellerini kapatan `9241c7e` mevcut; çalışma
  ağacı kabul başlangıcında ve doğrulamalar sonunda temizdi.
- `/readyz` database, artifact, workspace/disk ve app-server/auth bağımlılıklarını her
  istekte bounded gerçek probe ile ölçüyor; başlangıç preflight sonucu runtime doğruluk
  kaynağı değil. Failure ve recovery deterministik testlerle doğrulandı.
- Approval resolve, session lifecycle ve recovery state değişiklikleri ilgili audit
  kaydıyla aynı SQLite transaction'ına alındı. Failure injection rollback ve concurrent
  approval yarışında tek başarılı `approval.decided` kaydı geçti.
- Gerçek control-plane akışları read-only/change/approval/recovery audit zincirlerini
  sıralı, scoped, duplicate'siz ve reopen sonrasında kalıcı olarak doğruluyor; prompt,
  model çıktısı, diff, credential ve hassas path sızıntısı reddediliyor.
- İki store instance'ı WAL ve `BEGIN IMMEDIATE` altında eşzamanlı yazımda serialize
  oldu; retry aynı idempotency key ile duplicate audit üretmedi. Contention sınırı ADR
  ve operasyon dokümanında açıklandı.
- Güncel HEAD üzerinde format, bütün package typecheck'leri, 12 test dosyasında 119
  test, production build ve sandbox dışında `/` ile `/sessions/:sessionId` SSR HTTP
  smoke'u geçti.
- Genişletilmiş auth-none smoke; auth audit'i, bounded metric ve bütün runtime cleanup
  sonuçlarını doğruladı. Gerçek restart/recovery smoke; aynı thread, boşluksuz benzersiz
  event'ler, dedupe snapshot, readiness, recovery/restart audit'i, bounded restart
  metric ve tam cleanup sonuçlarıyla geçti.
- `9241c7e` UI dosyalarını değiştirmedi; önceki bağımsız browser kabulünde audit paneli
  reload sonrasında kalıcıydı ve desktop 1280×720 ile mobil 390×844 görünümünde yatay
  taşma, overlay veya console warning/error üretmedi.

Uygulama commit'leri: `5a9b6c4` (`feat: add durable audit and alpha metrics`) ve
`9241c7e` (`fix: complete WP11 audit and readiness guarantees`).

Aktif iş paketi WP12'dir. WP12 tamamlanmadan Faz 1 kapatılamaz.

## WP12 uygulama teslimatı — kabul bekliyor

Durum: **Uygulandı / kabul bekliyor**

- `pnpm alpha:accept`, gerçek model çalıştırmadan deterministic soak, mevcut integration,
  build, SSR, cleanup ve güvenlik kontrollerini tek redakte release gate altında toplar.
- `pnpm alpha:canary`, izole gerçek read-only, değişiklik/hedefli test/Git, tek approval
  kararı ve restart/resume/readiness/audit/metrics akışlarını ayrı opt-in gate olarak çalıştırır.
- `pnpm alpha:soak` process/child, FD, SQLite/WAL/SHM, artifact/temp, RSS/CPU, audit,
  realtime queue ve browser timeline sınırlarını ölçülebilir eşiklerle raporlar.
- `pnpm alpha:lifecycle` fake app-server start/stop/restart, v5→v6 migration ve offline
  SQLite checkpoint/backup/restore bütünlüğünü geçici kaynaklarda prova eder.
- Runbook, release checklist ve Faz 1 exit eşleme raporu `docs/operations` altında eklendi.

Bu kayıt WP12'yi veya Faz 1'i tamamlandı yapmaz; bağımsız WP12 kabulü beklenmektedir.
