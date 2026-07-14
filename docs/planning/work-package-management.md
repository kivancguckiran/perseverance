# İş Paketi Yönetim Protokolü

- Belge durumu: Aktif
- Başlangıç tarihi: 14 Temmuz 2026
- Yönetim kaynağı: `docs/planning/poc-implementation-plan.md`

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

| İş paketi                                    | Durum      | Not                                                                                                         |
| -------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| WP0 — Repository ve protokol temeli          | Tamamlandı | Generator, sürüm pini, schema hash ve `pnpm verify` doğrulandı                                              |
| WP1 — Workspace Agent process ve RPC köprüsü | Tamamlandı | Typed lifecycle hataları, timeout, restart/backoff, crash-loop, health state ve gerçek handshake doğrulandı |
| WP2 — Normalize event adapter                | Tamamlandı | Hedef mapping'ler, runtime validation, reconciliation, redaction/checksum ve golden fixture'lar doğrulandı  |
| WP3 — Session, event store ve replay         | Tamamlandı | Atomik ingest, durable session/event store ve boşluksuz high-water replay/live geçişi doğrulandı            |
| WP4 — Gerçek thread ve turn akışı            | Tamamlandı | Restart-safe ingest, collision guard, observable delivery error ve iki-instance browser akışı doğrulandı    |
| WP5 — Approval state machine                 | Tamamlandı | Durable state machine, concurrent karar, gerçek smoke ve responsive approval UI doğrulandı                  |
| WP6 — Resume, reconnect ve recovery          | Aktif      | Kalıcı Codex home, thread resume, reconnect ve açık recovery davranışı tamamlanacak                         |
| WP7 — Büyük çıktı ve timeline dayanıklılığı  | Bekliyor   | —                                                                                                           |
| WP8 — Golden senaryolar ve PoC demosu        | Bekliyor   | —                                                                                                           |

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
