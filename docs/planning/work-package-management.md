# İş Paketi Yönetim Protokolü

- Belge durumu: Aktif
- Başlangıç tarihi: 14 Temmuz 2026
- Yönetim kaynakları: `docs/planning/poc-implementation-plan.md` ve
  `docs/planning/phase-1-alpha-plan.md` ve
  `docs/planning/phase-2-provider-platform-plan.md` ve
  `docs/planning/phase-3-security-and-cursor-plan.md` ve
  `docs/planning/phase-4-corpus-mobile-and-phase-5-production-plan.md` ve
  `docs/planning/phase-6-open-source-and-managed-cloud-plan.md`

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
| WP6 — Resume, reconnect ve recovery          | Tamamlandı | Kalıcı home, aynı-thread resume, recovery, steer/interrupt ve session route doğrulandı                      |
| WP7 — Büyük çıktı ve timeline dayanıklılığı  | Tamamlandı | Uçtan uca bounded output, redakte artifact, backpressure ve responsive timeline doğrulandı                  |
| WP8 — Golden senaryolar ve PoC demosu        | Tamamlandı | Üç gerçek golden görev, dört arıza senaryosu, cleanup ve responsive browser kabulü doğrulandı               |
| WP9 — Alfa başlatma ve auth bootstrap        | Tamamlandı | Güvenli provisioning, readiness ve actionable auth recovery bağımsız olarak doğrulandı                      |
| WP10 — Workspace ve Git görünürlüğü          | Tamamlandı | Scoped session navigasyonu, durable Git snapshot ve responsive salt-okunur yüzey doğrulandı                 |
| WP11 — Audit ve temel metrics                | Tamamlandı | Atomik durable audit, dinamik readiness, bounded metrics ve contention davranışı doğrulandı                 |
| WP12 — Alfa hardening ve kabul               | Tamamlandı | Deterministic gate, gerçek canary, lifecycle ve responsive release kabulü doğrulandı                        |
| WP13 — Platform ve usage ledger temeli       | Tamamlandı | Provider-neutral sözleşme, schema v9, model politikası ve append-only usage ledger doğrulandı               |
| WP14 — Durable detached execution            | Tamamlandı | Schema v10 durable run, disconnect/replay, explicit interrupt, recovery ve accounting doğrulandı            |
| WP15 — Çok sağlayıcılı conversation          | Tamamlandı | Claude/Gemini adapter, model seçimi ve otomatik başlık uygulanacak                                          |
| WP16 — PWA ve Faz 2 kabulü                   | Tamamlandı | PWA, maliyet görünümü ve uçtan uca provider/recovery kabulü tamamlandı                                      |
| WP17 — Cursor Agent provider adapter         | Tamamlandı | Cursor adapter güncel runtime ve gerçek smoke ile bağımsız kabul edildi                                     |
| WP18 — Tenant kimliği ve data isolation      | Tamamlandı | OIDC, deny-by-default authorization, RLS/object/cache tenant sınırı bağımsız kabul edildi                   |
| WP19 — Runtime ve encryption isolation       | Tamamlandı | Kata runtime, egress, secret lease, KMS envelope encryption ve restore sınırı bağımsız kabul edildi         |
| WP20 — Security beta kabulü                  | Tamamlandı | Durable support grant/JIT/break-glass ve birleşik adversarial Faz 3 kabulü bağımsız doğrulandı              |
| WP21 — Corpus ingestion temeli               | Tamamlandı | Tenant-aware source registry, extraction, chunk ve derived index omurgası bağımsız kabul edildi             |
| WP22 — Hybrid retrieval ve MCP               | Tamamlandı | ACL filtreli hybrid search, citation, watcher/reindex ve workspace-local MCP bağımsız kabul edildi          |
| WP23 — Mobil approval ve push                | Tamamlandı | Güvenli push, mobil diff/approval ve çoklu cihaz sürekliliği bağımsız kabul edildi                          |
| WP24 — Billing, kredi ve gelir/marj kabulü   | Tamamlandı | Prepaid kredi, reservation, gelir/COGS/marj ve billing kabulü bağımsız doğrulandı                           |
| WP25 — Paylaşımlı klasör ve Faz 4 kabulü     | Tamamlandı | Davet, rol/ACL, durable ortak task/billing ve birleşik Faz 4 kabulü bağımsız doğrulandı                     |
| WP26 — HA topology ve kapasite               | Tamamlandı | Production HA, durable scheduler, fencing recovery ve noisy-neighbor sınırları bağımsız kabul edildi        |
| WP27 — SLO ve DR                             | Tamamlandı | Gerçek PITR/restore, dependency game-day, SLO alertleri ve telemetry güvenliği bağımsız kabul edildi        |
| WP28 — Enterprise lifecycle                  | Tamamlandı | Gerçek SSO/SCIM, retention/export/delete, crypto-erasure ve residency bağımsız kabul edildi                 |
| WP29 — Supply-chain ve canary                | Tamamlandı | İmzalı build, provider canary, güvenli upgrade ve compliance evidence bağımsız kabul edildi                 |
| WP30 — Production kabul ve rollout           | Tamamlandı | WP30-L local production-like engineering kabulü geçti; WP30-E production go-live öncesi zorunlu             |
| WP31 — Open-source release hazırlığı         | Aktif      | Lisans, secret/history, dependency ve public-release güvenlik sınırları tamamlanacak                        |
| WP32 — Self-hosted dağıtım                   | Planlandı  | Tek komutlu kurulum, upgrade, backup/restore ve subscription login doğrulanacak                             |
| WP33 — Managed tenant runtime                | Planlandı  | Community/Cloud profilleri ve tenant-isolated managed runtime kurulacak                                     |
| WP34 — Provider account bağlantıları         | Planlandı  | Subscription OAuth, API/platform auth ve credential lifecycle güvenli hale getirilecek                      |
| WP35 — Managed Cloud public beta             | Planlandı  | Onboarding, billing, operasyon ve kontrollü public beta ile Faz 6 kapatılacak                               |

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

## WP12 nihai kabul ve Faz 1 kapanış sonucu

Karar: **WP12 Tamamlandı — Faz 1 Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `0d4fb67` (`feat: complete single-tenant alpha acceptance`)
  mevcut; kabul başlangıcında ve sonunda çalışma ağacı temizdi.
- `pnpm install --frozen-lockfile` temiz ve non-interactive kurulumda geçti. Pinli
  protocol generator iki ardışık çalışmada generated drift üretmedi.
- `pnpm alpha:accept`; deterministic soak, format/typecheck/test/build/SSR güvenlik
  zinciri ve lifecycle recovery aşamalarını geçti.
- Soak; 12 fake-runtime çevriminde child process, file descriptor, RSS, CPU,
  SQLite/WAL/SHM, artifact ve audit retention eşiklerinin tamamını geçti; geçici runtime
  veya orphan process bırakmadı.
- Lifecycle provası v5→v6 migration, integrity-check edilmiş offline backup/restore,
  iki runtime generation, WAL checkpoint, SHM kapanışı ve cleanup sonuçlarını doğruladı.
- `pnpm alpha:canary`; gerçek Codex read-only turn, küçük değişiklik + hedefli test + Git,
  tek approval kararı ve restart/resume/readiness/audit/metrics aşamalarının tamamını
  isolated runtime ve doğrulanmış cleanup ile geçti.
- Bağımsız browser denetiminde yakın session geçişi doğru session-scoped sequence'e
  geçti; Git branch/HEAD/status/log ve durable audit görünür kaldı. Desktop 1280×720 ve
  mobil 390×844 görünümünde yatay taşma, offscreen öğe, Vite overlay veya console
  warning/error oluşmadı.
- Browser tab'ları ve geliştirme süreçleri kapatıldı; 3000/3100 portlarında listener,
  geçici DB/WAL/SHM, artifact, workspace veya Codex home kalmadı.
- Faz 1 exit kriterlerinin tamamı release checklist ve kabul raporundaki tekrarlanabilir
  komutlarla karşılandı.

Uygulama commit'i: `0d4fb67` (`feat: complete single-tenant alpha acceptance`).

Aktif iş paketi yoktur. Yeni çalışma Faz 2 planı hazırlanıp kabul edilmeden başlatılmaz.

## Faz 2 plan aktivasyonu

Faz 2 kalıcı çok sağlayıcılı ajan platformu planı
`docs/planning/phase-2-provider-platform-plan.md` içinde WP13–WP16 olarak tanımlandı.
Faz 1'in app-server supervision, durable event/replay, approval, artifact, audit ve
responsive conversation temeli yeniden uygulanmayacaktır. WP13 tek aktif pakettir;
WP14–WP16 bağımlılık sırasıyla beklemektedir.

Maliyet kayıtlarında `completed`, `failed` ve `interrupted` lifecycle sonuçları
ayrıştırılır; ölçülmüş kullanım her durumda korunur, eksik terminal usage sıfır kabul
edilmez. `sol` ve `luna` gerçek provider model ID'si değil, config ve discovered model
catalog üzerinden çözülen ürün politikası alias'larıdır.

## WP13 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `f2cde59` (`feat: add provider platform and usage ledger
foundation`) mevcut ve WP13 kapsamını taşıyor.
- ADR-0012 ile provider-neutral lifecycle/capability/usage sınırı tanımlandı; mevcut
  Codex `app-server` adapter'ı yeniden yazılmadan `model/list` katalog köprüsüne bağlandı.
- `sol` ve `luna` alias'ları config + discovered catalog üzerinden çözülüyor;
  çözülemeyen model/effort typed ve actionable hata üretiyor.
- Schema v9 migration; session ve turn provider/model/effort/capability snapshot'ları
  ile append-only usage ledger'ı reopen ve tenant/session scope testleriyle koruyor.
- Cumulative/delta usage dedupe, replay/restart, completed/failed/interrupted sonuçları,
  eksik terminal usage için `partial/unreconciled` ve versioned fiyat tahmini fixture'larla
  doğrulandı.
- Güncel HEAD üzerinde Prettier, bütün package typecheck'leri, 14 test dosyasında 158
  test ve production build geçti. Sandbox port kısıtı dışında yeniden çalıştırılan SSR
  HTTP smoke'u `/` ve `/sessions/:sessionId` için geçti.
- Kabul sonunda çalışma ağacı temizdi. Sonraki `fda8c1d` conversation/attachment commit'i
  ayrı kapsamda olup WP13 regresyonu oluşturmadı.

Uygulama commit'i: `f2cde59` (`feat: add provider platform and usage ledger foundation`).

Aktif iş paketi WP14'tür. WP14 tamamlanmadan WP15'e geçilemez.

## WP14 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `0d75a1e` (`feat: add durable detached turn execution`) mevcut ve
  WP14 kapsamını taşıyor.
- ADR-0013 ile browser/WebSocket subscription ömrü server-owned execution'dan ayrıldı;
  browser disconnect provider interrupt üretmiyor, yalnız explicit Durdur kararı
  idempotent interrupt akışını başlatıyor.
- Schema v10 `durable_runs` tablosu ve partial unique index session başına tek
  queued/running/interrupting run'ı transaction sınırında koruyor.
- Delayed provider integration testi WebSocket kapandıktan sonra aynı run/turn'ün
  tamamlandığını, reconnect snapshot/replay ile terminal çıktının geldiğini ve usage
  ledger'ın duplicate üretmediğini doğruluyor.
- Restart reconcile aynı persistent thread'i okuyor/resume ediyor; belirsiz upstream
  sonuç otomatik prompt tekrarı yerine `recovery_required` oluyor.
- Completed/failed/interrupted terminal accounting ölçülmüş kullanımı koruyor; eksik
  terminal usage `partial/unreconciled` kalıyor.
- Güncel HEAD üzerinde Prettier, bütün package typecheck'leri, 14 test dosyasında 164
  test, production build ve izinli localhost'ta SSR HTTP smoke geçti.
- Gerçek pinli Codex alfa canary read-only, file change + targeted test + Git, tek
  approval ve restart/resume/readiness/audit/metrics aşamalarını cleanup ile geçti.
- Güncel HEAD'den açılan izole web instance'ında 1280×720 ve 390×844 görünümleri yatay
  taşma veya o instance'a ait console warning/error üretmedi. Önceden açık 3000 dev
  sürecindeki stale HMR import hatası izole instance'ta tekrarlanmadı.
- Kabul sonunda geçici browser tab'ı, viewport override ve izole dev process kapatıldı;
  çalışma ağacı temiz kaldı.

Uygulama commit'i: `0d75a1e` (`feat: add durable detached turn execution`).

Aktif iş paketi WP15'tir. WP15 tamamlanmadan WP16'ya geçilemez.

## WP15 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama ve düzeltme commit'leri `aabd6bd`, `ddd3079`, `37455d2` ve `5835809`
  mevcut ve WP15 kapsamını taşıyor.
- Claude ve Gemini process adapter'ları ortak provider-neutral arayüzden start, resume,
  stream, usage, unknown event, interrupt ve cleanup davranışlarını sağlıyor.
- Provider readiness üç durumlu ve typed; capacity/auth/config hataları kullanıcıya
  actionable biçimde aktarılıyor. Claude effort eşlemesi uygulanırken Gemini'nin
  desteklemediği effort değerleri sessizce kabul edilmiyor.
- Conversation provider/model/effort seçimi kalıcı; yeni Codex conversation
  `sol + medium` ile başlıyor. İkinci kullanıcı mesajı tek bir idempotent title job
  üretiyor; `luna + none` policy'si ve `conversation_title` usage amacı korunuyor.
- Interrupt lifecycle fixture'ındaki ready/signal yarışı giderildi. Provider adapter
  testi 10 bağımsız paralel tekrarda 10/10 geçti.
- Gerçek Claude `sonnet`, Gemini `gemini-2.5-pro` ve Codex title `gpt-5.6-luna`
  smoke'ları start/resume/interrupt veya title policy akışlarını cleanup ile tamamladı.
- Güncel HEAD üzerinde format, bütün typecheck'ler, 16 test dosyasında 196 test,
  production build ve izinli localhost'ta `/` ile `/sessions/:sessionId` SSR HTTP smoke
  geçti.
- İzole güncel web instance'ında 1280×720 ve 390×844 görünümleri yatay taşma veya
  console warning/error üretmedi; provider/model/effort kontrolleri iki viewport'ta da
  erişilebilirdi.
- Kabul sonunda geçici browser tab'ı ve izole dev process kapatıldı; çalışma ağacı
  temiz kaldı.

Uygulama commit'leri: `aabd6bd`, `ddd3079`, `37455d2`, `5835809`.

WP16 uygulandı ve bağımsız kabul bekliyor. WP16 kabul edilmeden Faz 2 kapatılamaz; yeni
bir work package başlatılmaz.

## WP16 nihai kabul ve Faz 2 kapanış sonucu

Karar: **Tamamlandı — Faz 2 kapatıldı**

Doğrulananlar:

- Uygulama commit'i `bbd6cbd` (`feat: complete Phase 2 PWA and cost acceptance`)
  mevcut ve WP16 kapsamını taşıyor.
- Installable manifest/ikonlar, versioned Service Worker, güvenli cache sınırı,
  read-only offline history, offline gönderim/upload engeli ve online snapshot +
  high-water replay uygulandı.
- Conversation, turn ve title usage/cost kırılımı; completed, failed, interrupted,
  partial, estimated, unreconciled ve reconciled durumları test edildi. Eksik usage
  sıfır maliyet gibi gösterilmiyor.
- OpenAI ve Anthropic resmi cost kaynakları server-only admin credential ve stable
  dedupe üzerinden provider-neutral reconciliation portuna bağlı. Admin credential
  olmayan ortam estimated/unreconciled kalıyor; Gemini için turn-level resmi cost
  kaynağı olmadığı belgeli.
- `pnpm phase2:accept`; 7 dosyada 156 test, unknown-event durable replay, production PWA
  build ve gerçek Chrome üzerinde 1280×720/390×844, controlled Service Worker,
  offline/online acceptance aşamalarını geçti.
- `pnpm verify`; Prettier, 11 workspace typecheck'i, 17 test dosyasında 213 test,
  production build ve `/` ile `/sessions/:sessionId` SSR HTTP smoke'unu geçti.
- Canlı `phase2:smoke:live`; dört aşamalı Codex canary, Claude `sonnet`, Gemini
  `gemini-2.5-pro` ve Codex title `gpt-5.6-luna + none` akışlarını usage,
  unknown-event ve cleanup kanıtlarıyla geçti.
- In-app browser kontrolünde scoped provider catalog API 200 döndü; desktop ve mobil
  görünüm taşma veya console warning/error üretmedi. Normal dev instance'ında Codex auth
  yokken readiness doğru biçimde `AUTH_REQUIRED`, `readOnlyAvailable=true` bildirdi.
- Resmi OpenAI/Anthropic admin cost credential'ları bu kabul ortamında bulunmadığından
  canlı fatura reconciliation'ı çalıştırılmadı; fixture/contract/integration kanıtları
  geçti ve bu sınırlama kabul raporunda görünür tutuldu.
- Geçici browser tab'ı, viewport override ve dev process kapatıldı; çalışma ağacı ve
  3000/3100 portları temiz bırakıldı.

Uygulama commit'i: `bbd6cbd` (`feat: complete Phase 2 PWA and cost acceptance`).

Aktif iş paketi yoktur. Faz 2 tamamlanmıştır; yeni çalışma ayrı bir plan ve açıkça
aktive edilmiş yeni bir work package olmadan başlatılmaz.

## Cursor köprüsü ve Faz 3 plan taslağı

WP17–WP20, `docs/planning/phase-3-security-and-cursor-plan.md` içinde planlandı. WP17
Cursor Agent provider adapter'ını ekler. WP18–WP20 sırasıyla tenant kimliği/veri
izolasyonu, runtime/şifreleme izolasyonu ve admin access/adversarial security beta
kapanışını taşır.

Ana spesifikasyonun eski Faz 2 multi-tenant private beta numarası, tamamlanmış provider
platformu Faz 2 kaydıyla çakıştığı için yeni uygulama sırası Faz 3 Multi-tenant Security
Beta, Faz 4 Corpus ve mobil ürün, Faz 5 Production hardening olarak belirlenmiştir.

Plan kabul edilmiş ve WP17 tek aktif iş paketi olarak açılmıştır. WP17 bağımsız kabul
edilmeden WP18'e geçilmez.

## WP17 uygulama teslimatı — kabul bekliyor

Cursor Agent provider adapter, ADR-0015 sürüm/capability politikası, bounded stream
parser, readiness/auth, project permission doğrulaması, durable session resume,
explicit interrupt, partial usage/cost davranışı, control-plane/UI seçimi ve opt-in
gerçek smoke komutuyla uygulanmıştır. Bu kayıt WP17’yi kabul edilmiş saymaz; WP18
aktive edilmemiştir.

## WP17 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `761552d` ve güncel Cursor runtime düzeltme commit'i `28a3374`
  mevcut ve WP17 kapsamını taşıyor.
- Cursor Agent `2026.07.09-a3815c0` exact doğrulanmış release allowlist'inden geçiyor;
  farklı hash/sürüm fixture ve gerçek smoke olmadan fail-closed reddediliyor.
- Server-side JSON readiness gerçek authenticated durum döndürüyor; credential argv,
  event, log, fixture, audit veya UI'a taşınmıyor.
- Gerçek Cursor smoke model `auto` ile start/stream, tool started/completed, durable
  session, resume, explicit interrupt, terminal interrupted, provider-reported complete
  usage, raw/unknown-event koruması ve cleanup aşamalarını geçti.
- Stream reasoning içeriği saklanmıyor; bilinmeyen event redakte raw envelope ile
  `cursor.unknown` kalıyor. Malformed/oversized/early EOF ve version/auth/readiness
  senaryoları fixture testleriyle fail-closed.
- Project `.cursor/cli.json` policy'si platform sınırından genişleyemiyor; sensitive
  path, traversal, symlink ve workspace escape testleri geçiyor. `--force` varsayılan
  kapalı ve iki ayrı policy kararı gerektiriyor.
- Güncel HEAD üzerinde 6 hedefli test dosyasında 154 test ve repository genelinde 17
  dosyada 224 test geçti; bütün typecheck'ler, production build ve SSR HTTP smoke
  başarılıydı.
- Production browser acceptance 1280×720 ve 390×844 görünümü, PWA/offline-online replay
  ve sıfır page error ile geçti.
- Çalışma ağacı temizdi.

Uygulama commit'leri: `761552d`, `28a3374`.

Aktif iş paketi WP18'dir. WP18 tamamlanmadan WP19'a geçilemez.

## WP18 uygulama teslimatı — kabul bekliyor

Durum: **Uygulandı / kabul bekliyor**

- Versioned OIDC principal, organization membership ve merkezi deny-by-default
  authorization contract/policy katmanı eklendi.
- Public REST ve realtime subscribe/ack scope'u doğrulanmış principal ile server-side
  membership'e bağlandı; route coverage fail-closed hale getirildi.
- SQLite schema v12 identity/membership/audit geliştirme modelini; PostgreSQL migration
  18 composite FK, forced RLS ve tenant object metadata temelini ekledi.
- Tenant-scoped artifact/attachment grant testleri ile principal/org/workspace
  namespace'li query/offline cache sınırı genişletildi.
- Gerçek `postgres:17-alpine` / PostgreSQL `17.10` RLS smoke ile tenant-aware desktop
  ve mobile browser acceptance geçti. Gemini CLI `0.50.0` version/fixture regresyonu
  ile gerçek `gemini-2.5-pro` start/stream/resume/interrupt/usage/cleanup smoke’u geçti.
  Nihai repository doğrulamaları tamamlandı; teslim commit’i sonrası WP18 bağımsız
  kabul beklemeye devam eder.

WP19 aktive edilmemiştir.

## WP18 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `b2478a2` (`feat: enforce tenant identity and data isolation`)
  mevcut ve WP18 kapsamını taşıyor.
- OIDC issuer/JWKS/signature/algorithm/audience/lifetime doğrulaması fail-closed;
  organization yetkisi token claim'i yerine server-side membership'ten türetiliyor.
- Merkezi action/resource authorization bilinmeyen route/action ve eksik scope'u deny
  ediyor. REST ve WebSocket subscribe/ack/replay cross-tenant testleri geçiyor.
- PostgreSQL migration 18 composite FK ve forced RLS uyguluyor. Gerçek
  `postgres:17-alpine` / PostgreSQL `17.10` smoke'unda application rolü superuser,
  table owner veya `BYPASSRLS` değildi; cross-tenant SELECT gizlendi ve
  INSERT/UPDATE/DELETE/FK denemeleri reddedildi.
- Transaction-local organization/workspace context commit ve rollback sonrasında
  temizlendi; connection reuse önceki tenant context'ini sızdırmadı. Container ve
  anonymous storage cleanup doğrulandı.
- Tenant-scoped opaque artifact/attachment grant, expiry/replay/path/range sınırları ile
  principal+organization+workspace query/offline cache namespace'i test edildi.
- Gemini CLI `0.50.0`, model `gemini-2.5-pro` gerçek smoke'u start/stream, durable
  session, resume, explicit interrupt, complete usage, unknown-event ve cleanup ile
  geçti.
- Production browser acceptance 1280×720 ve 390×844 görünümü, offline history,
  online high-water replay ve tenant-switch snapshot isolation'ını sıfır page error ile
  geçti. İlk tekrardaki geçici-dizin cleanup yarışı ikinci bağımsız çalıştırmada
  tekrarlanmadı ve gate exit 0 oldu.
- Güncel HEAD'de 7 hedefli test dosyasında 166 test ve repository genelinde 19 dosyada
  243 test geçti; 12 workspace typecheck'i, production build ve SSR HTTP smoke
  başarılıydı.
- Çalışma ağacı, test portları ve geçici PostgreSQL container'ları temizdi.

Uygulama commit'i: `b2478a2`.

Aktif iş paketi WP19'dur. WP19 tamamlanmadan WP20'ye geçilemez.

## WP19 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `3e5e6f7` ve production isolation kanıt commit'i `18d0dcb`
  mevcut.
- Gerçek Kata Containers smoke'u `kata-qemu` micro-VM, hosttan farklı guest kernel,
  encrypted ve bound workspace PVC, hostPath yasağı, metadata/service-account token
  reddi ve default-deny cross-runtime network sınırını kanıtladı.
- Gerçek customer-managed AWS KMS encrypt/decrypt round-trip geçti; yanlış tenant
  encryption context'i reddedildi. Secret içermeyen key hash'ine karşılık gelen
  anahtarın AWS üzerinde `PendingDeletion` olduğu bağımsız doğrulandı.
- PostgreSQL 17.10 migration 18+19 idempotent, forced-RLS ve cross-tenant
  crypto-state reddiyle geçti.
- Workspace security testleri, rotation, revoked-key, crypto-erasure ve encrypted
  backup/restore kontrolleri geçti.
- `pnpm verify` 20 dosyada 254 test, typecheck, production build ve SSR HTTP smoke
  ile tamamlandı. Çalışma ağacı ve geçici PostgreSQL kaynağı temizdi.

Uygulama commit'leri: `3e5e6f7`, `18d0dcb`.

Aktif iş paketi WP20'dir. WP20 tamamlanmadan Faz 3 kapatılamaz.

## WP20 nihai kabul ve Faz 3 kapanış sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Uygulama commit'i `b842d6a` ve durable production düzeltme commit'i `f4863e7`
  mevcut.
- Contract, control-plane route'ları ve PostgreSQL migration 20 aynı versioned grant,
  approval, JIT lease, break-glass, outbox, audit ve revocation modeline bağlandı.
- Production modu PostgreSQL support repository olmadan fail-closed. In-memory adapter
  yalnız explicit test/development kullanımıyla açılıyor.
- Gerçek PostgreSQL-backed control-plane restart testinde pending/active grant,
  revocation generation, tek kullanımlık lease, audit zinciri ve outbox retry durumu
  kayıpsız geri geldi.
- Normal admin grantsiz içeriğe erişemedi; support erişimi exact-scope JIT lease
  tüketerek gerçek korunan content/download hattından geçti. Replay, yanlış scope ve
  revoke sonrası kullanım reddedildi.
- KMS approval sıraları, failed-decision rollback, separation-of-duty, break-glass çift
  onayı, alarm ve notification recovery testleri geçti.
- `pnpm phase3:accept` migration 18–20, WP18–WP20 adversarial paketleri,
  persistent-adapter responsive browser E2E, credential scan ve cleanup ile geçti.
- `pnpm verify` 21 dosyada 265 test, typecheck, production build ve SSR HTTP smoke ile
  tamamlandı. Browser 1280x720 ve 390x844 görünümde sıfır page error/secret leak
  üretti.
- WP19'da bağımsız kabul edilen gerçek Kata micro-VM, encrypted storage ve AWS KMS
  kanıtı geçerliliğini koruyor; WP20 düzeltmesi bu kod yollarını değiştirmedi.
- Çalışma ağacı ve geçici PostgreSQL container'ları temizdi.

Uygulama commit'leri: `b842d6a`, `f4863e7`.

WP20 ve Faz 3 tamamlandı. Aktif iş paketi yoktur; Faz 4 planlanıp kabul edilmeden yeni
uygulama paketi başlatılmaz.

## Faz 4 ve Faz 5 plan kabulü

Faz 4 Corpus ve mobil ürün WP21–WP25; Faz 5 Production hardening WP26–WP30 olarak
`docs/planning/phase-4-corpus-mobile-and-phase-5-production-plan.md` içinde planlandı.
Paketler source ingestion, retrieval/MCP, mobil/push, billing/kota, paylaşımlı klasör
ortak çalışması, HA/capacity, observability/DR, enterprise lifecycle,
supply-chain/canary ve nihai production kabulünü bağımsız doğrulanabilir sınırlara
ayırır.

WP21 tek aktif iş paketidir. WP21 bağımsız kabul edilmeden WP22'ye geçilemez.

## WP21 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- PostgreSQL corpus repository, forced RLS, durable restart recovery, concurrent
  claim, duplicate upload dedupe, deterministic rebuild ve append-only embedding
  usage muhasebesi gerçek PostgreSQL smoke'unda iki kez geçti.
- Immutable snapshot storage, workspace-security KMS/envelope encryption altyapısını
  kullanıyor. Tenant/workspace/revision/storage-key/content-hash context substitution,
  ciphertext/tag/wrapped-key değişikliği, key revoke ve crypto-erasure fail-closed
  testlerle doğrulandı.
- Gerçek Poppler extraction ve bounded parser limitleri; malformed, oversized,
  timeout ve poison source senaryoları geçti.
- Gerçek browser kabulü iki ardışık kez 1280x720 ve 390x844 görünümde geçti;
  pending/extracting/indexed/failed/delete-reindex, reload durability ve cross-tenant
  gizleme doğrulandı.
- `pnpm verify` 23 dosyada 283 test, typecheck, production build ve SSR HTTP smoke ile
  geçti. Test cleanup çıktıları container, volume ve temp dizin sızıntısı olmadığını
  gösterdi.

Uygulama commit'leri: `f843b35`, `3afad1a`, `98d5f88`, `94a7a77`.

WP21 tamamlandı. Aktif iş paketi WP22'dir; WP22 tamamlanmadan WP23'e geçilemez.

## WP22 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- Hybrid lexical/vector retrieval, ACL-before-ranking, versioned citation, bounded
  cache/token/top-k ve migration 22 gerçek PostgreSQL/pgvector üzerinde geçti.
- Normal session bootstrap managed workspace-local MCP'yi otomatik provision etti;
  proof-bound kısa ömürlü workload credential tenant/workspace/audience/action,
  replay, expiry ve revoke sınırlarıyla doğrulandı.
- Gerçek filesystem watcher startup reconciliation ile create/update/rename/delete
  olaylarını durable watch job ve reindex hattına bağladı; ignore, symlink/path escape,
  debounce, backlog ve cleanup testleri geçti.
- Pinli Codex 0.144.2 gerçek turn'de `search_corpus` çağırdı; source/revision/chunk ve
  locator citation'ı final cevap ve timeline'da görünür oldu. Malicious corpus talimatı
  yürütülmedi ve raw reasoning saklanmadı.
- `pnpm wp22:accept` hedefli 24 test, pgvector, agent E2E ve üç viewport browser E2E
  kapılarını geçti. Cross-tenant ve unauthorized principal sonuçları sıfırdı; reconnect,
  keyboard, screen-reader label, yatay taşma, page error ve credential leak kontrolleri
  geçti.
- `pnpm verify` 27 test dosyasında 294 test, typecheck, build ve SSR HTTP smoke ile
  tamamlandı. Geçici kaynaklar temizlendi ve çalışma ağacı temiz kaldı.

Uygulama commit'leri: `e7b9b40`, `cd24e14`.

WP22 tamamlandı. Aktif iş paketi WP23'tür; WP23 tamamlanmadan WP24'e geçilemez.

## WP23 nihai kabul sonucu

Karar: **Tamamlandı**

Doğrulananlar:

- PWA manifest, versioned service worker, kontrollü update ve tenant/principal scoped
  offline read-only history production build'e bağlandı; offline turn veya approval
  kuyruğu oluşturulmadı.
- Migration 23 ve PostgreSQL push repository forced RLS, encrypted subscription,
  rotate/revoke/expiry, outbox retry, invalid endpoint ve duplicate/out-of-order
  delivery idempotency kontrollerini geçti.
- Notification payload allowlist ve secret/content scan'i sıfır sızıntıyla geçti;
  notification deep link auth/authorization sonrasında session/approval'ı çözüyor.
- İki bağımsız cihazın approval yarışında tek CAS kazananı ve tek upstream response
  oluştu; diğer cihaz realtime ile aynı terminal sonucu gösterdi.
- Browser kapalıyken server-side task tamamlandı; reopen/reconnect high-water replay
  ile çıktıyı geri getirdi. Scroll lock, keyboard, screen-reader label, reduced motion
  ve 44px touch target kontrolleri geçti.
- `pnpm wp23:accept` 99 hedefli test, gerçek PostgreSQL ve 390x844, 768x1024,
  1280x720 browser/PWA kapılarını geçti. `pnpm verify` 29 test dosyasında 299 test,
  typecheck, build ve SSR HTTP smoke ile tamamlandı.
- Gerçek VAPID/provider credential bulunmadığından opt-in/delivery smoke'u
  çalıştırılmadı; emulator production delivery kanıtı sayılmadı.

Uygulama commit'i: `3962844`.

WP23 tamamlandı. Aktif iş paketi WP24'tür; WP24 tamamlanmadan Faz 4 kapatılamaz ve WP25
başlatılamaz.

## WP24 prepaid kredi kapsam genişletmesi

WP24 ayrı bir paket açılmadan genişletildi. Aktif WP24 artık mevcut billing, usage,
plan ve quota kapsamına ek olarak şunları zorunlu kabul kriteri sayar:

- Append-only credit ledger ve derived available/reserved balance.
- Paid/promotional credit lot; payment top-up, refund, chargeback ve expiration.
- İş öncesi atomic reservation; ölçülen kullanım settlement'ı ve unused release.
- Failed/interrupted/incomplete task kullanımının doğru kredi tüketimi.
- Versioned retail price catalog; platform-managed ve BYOK ayrımı.
- Customer credit/history; admin cash collected, outstanding credit liability,
  consumed paid-credit revenue, provider/infrastructure COGS ve gross margin.
- Payment/settlement replay, concurrent double-spend ve cross-tenant RLS/browser
  adversarial testleri.

WP24 billing/quota ve birleşik E2E kanıtı bu genişletmeyi kapsayacak şekilde
güncellendi. İki
browser context'inin aynı `Accept once` kararını verdiği yarış kontrollü request
barrier üzerinden çalışır. Pinli Codex `0.144.2` ile üç ardışık browser koşusu ve tam
`phase4:accept` geçti. Son kanıt session
`ses_6392d8a4-df8d-445e-8b50-c05300c750ea`, approval
`apr_576a4699f8fc5922a7b9985b`, resolved event sequence `252`, CAS sonucu `a=200` /
`b=409`, settlement `cset_bfbcff8794d7da7aca9c91b6cd9c9b27` ve ledger watermark
`clw_30` değerlerini bağladı. Durable timeline'da bir resolution/upstream completion,
usage dedupe başına bir settlement ve iki context'te aynı resolved state doğrulandı.
Emulator sonucu production tahsilat veya delivery kanıtı değildir.

## WP24 nihai kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'leri `133d547`, `be0c74f`, `dac703c` ve deterministik browser
  concurrency düzeltmesi `3dff308` kabul edildi.
- Pinli Codex `0.144.2` ile üç ardışık bağımsız browser kabulü geçti. Her koşuda iki
  context aynı approval için barrier üzerinden yarıştı; bir `200`, bir güvenli `409`,
  tek durable resolution, tek upstream completion ve tek billing settlement oluştu.
- `pnpm phase4:accept`; 164 WP24 testi, 10 prepaid testi, gerçek PostgreSQL forced-RLS,
  runtime/browser E2E, WP22/WP23 regresyonları ve repo-wide verify ile geçti.
- Repo-wide verify 32 test dosyasında 319 testi, typecheck, production build ve SSR HTTP
  smoke'u tamamladı. Cleanup kanıtları geçti ve çalışma ağacı temiz kaldı.
- Gerçek billing/Web Push credential bulunmadığından ilgili production smoke'ları
  `not-run` kaldı; emulator production kanıtı sayılmadı.

WP24 tamamlandı. Aktif iş paketi WP25'tir; WP25 tamamlanmadan Faz 4 kapatılamaz.

## WP25 paylaşımlı klasör kapsamı

WP25, Faz 4'ün yeni ve son iş paketi olarak tamamlandı.

WP25'in hedefi, bir kullanıcının klasörü arkadaşına davet ederek paylaşması ve iki
kullanıcının yalnız bu klasöre bağlı conversation, source, attachment/artifact ve
agent task'larını birlikte kullanmasıdır. Private-by-default klasörler;
`owner`/`editor`/`viewer` rolleri; süreli, tek kullanımlık ve digest olarak saklanan
davetler; role/revoke/move sonrası cache ve realtime authorization yenilemesi; REST,
RLS, retrieval/MCP, object storage ve browser katmanlarında folder ACL zorunludur.
Security boundary ve veri modeli uygulamadan önce ADR ile kesinleştirilir.

Kabul; iki gerçek kullanıcıyla invite/accept, private kardeş klasör izolasyonu,
viewer/editor yetki ayrımı, expired/replayed invite ve revoke testleri, eşzamanlı
task/approval yarışında tek upstream iş ve tek billing settlement, gerçek PostgreSQL
forced-RLS ile üç viewport browser E2E kanıtını gerektirir. İlk sürüm paylaşılan klasör
kaynaklarını ve agent işlerini ortak kullanmayı kapsar; Google Docs benzeri aynı dosya
içeriğini canlı ortak düzenleme kapsam dışıdır. Son kabulde `pnpm phase4:accept`,
WP21–WP25 kapılarını birlikte çalıştırır.

## WP25 nihai kabul sonucu ve Faz 4 kapanışı

Karar: **Tamamlandı**

- Uygulama commit'leri `5b4a026`, `e47f1f9` ve `93185a3` kabul edildi.
- Shared-folder contract ve PostgreSQL adapter aynı async port altında tamamlandı;
  production composition durable repository yokluğunda fail-closed davranıyor.
- Forced RLS, invitation/ownership/resource/audit/restart ve cross-instance access
  invalidation testleri gerçek PostgreSQL üzerinde geçti.
- Pinli Codex `0.144.2` E2E'sinde iki principal aynı shared task için tek gerçek
  `runId/codexTurnId`; tek durable approval resolution; aynı usage dedupe, credit
  reservation ve gerçek billing settlement zincirini üretti.
- Retrieval/MCP citation, attachment, artifact, viewer/editor ayrımı, private sibling,
  interrupted/start-failed/admission-denied task ve realtime revoke doğrulandı.
- İki browser context'i invite/accept, role promotion, ortak task/approval ve erişim
  kaybını 390x844, 768x1024 ve 1280x720 görünümlerinde geçti.
- Birleşik `phase4:accept`, WP21–WP25 kapılarını; repo-wide verify ise 34 test dosyasında
  327 testi, typecheck, build ve SSR HTTP smoke'u başarıyla tamamladı. Cleanup geçti.
- Credential gerektiren gerçek billing/Web Push kontrolleri `not-run` kaldı; emulator
  production kanıtı sayılmadı.

WP25 ve Faz 4 tamamlandı. Tek aktif iş paketi Faz 5'in ilk paketi WP26'dır.

## WP26 nihai kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'leri `ffa8032` ve `b12957e` kabul edildi.
- `wp26:accept`, pinli Codex `0.144.2` ve gerçek Linux IO device ile 65 hedefli testi,
  PostgreSQL/RLS yarışını, iki API ve iki scheduler HA zincirini, live fairness ve
  poison senaryosunu, cgroup kapasite sınırlarını ve Chromium reconnect akışını geçti.
- API ve scheduler process kaybında approval context ile durable high-water replay
  korundu; stale fence reddedildi, duplicate Codex start oluşmadı ve drain edilen
  node'dan yeni node'a placement recovery gerçekleşti.
- Ölçülen scheduler recovery RPO değeri `0 ms`, RTO değeri `14.306 sn` oldu.
- PostgreSQL, RabbitMQ, MinIO, runtime-control ve Vault kaybında admission fail-closed
  `503` üretti; restore sonrası committed replay değişmedi.
- Repo genelinde format, typecheck, 345 test ve build geçti. Sandbox dışı localhost
  doğrulamasında SSR HTTP smoke `/` ve `/sessions/:sessionId` için başarılı oldu.
  Geçici WP26 container ve volume kalmadı; çalışma ağacı temizdi.

WP26 tamamlandı. Tek aktif iş paketi WP27'dir; WP27 kabul edilmeden WP28 başlatılmaz.

## WP27 nihai kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'leri `229c91d` ve `c40d655` kabul edildi.
- Bağımsız `wp27:accept` gerçek PostgreSQL PITR, izole PostgreSQL/MinIO/RabbitMQ/Vault
  restore'u, dependency pause/recovery, active/passive region failover, Prometheus
  alert yaşam döngüsü ve gerçek Codex telemetry E2E kapılarını geçti.
- Son koşuda PITR RPO/RTO `1.217/2.047 sn`, restore RTO `2.145 sn`, region failover
  RPO/RTO `0/1.119 sn` ölçüldü. Duplicate turn, event gap, stale fence, cross-tenant
  erişim, corrupt/missing backup ve unavailable key kontrolleri geçti.
- Gerçek collector çıktısında sekiz aşamalı trace zinciri doğrulandı; collector kaybı
  ürün akışını kesmedi ve telemetry drop metriği oluştu. Secret, prompt, output, PII
  ve corpus marker eşleşmesi sıfırdı.
- Dört Prometheus rule'u gerçek scrape target ile firing→inactive geçti. External
  paging ve cloud-managed bağımlılık kanıtları doğru biçimde `not-run` kaldı.
- Repo genelinde format, typecheck, 355 test, build ve SSR HTTP smoke geçti. Acceptance
  report checksum'ı `c5ebe8dd9ddf6949db486d4155d730bf37bc15fcd96092705c87665bcdd19ea9`;
  geçici container, volume ve process kalmadı.

WP27 tamamlandı. Tek aktif iş paketi WP28'dir; WP28 kabul edilmeden WP29 başlatılmaz.

## WP28 nihai kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'leri `dd225ff` ve `13cd5cf` kabul edildi.
- Bağımsız `wp28:accept`; Keycloak OIDC/SAML, PostgreSQL durable SCIM, gerçek
  retention/legal-hold, MinIO/Vault export, durable delete/crypto-erasure, residency,
  gerçek Codex deprovision ve Chromium kapılarını geçti.
- SCIM üç API instance'ında restart-safe ve idempotent kaldı. Aktif turn deprovision'u
  session/token/realtime/cache/support/lease/run state'lerini kapattı; dört yeni
  admission yolu `403` döndürdü.
- Dokuz retention sınıfı hold-release sonrası temizlendi. Export checkpoint resume,
  manifest/checksum, range download ve support denial geçti. Offboarding 11 durable
  adımı crash/restart ile tamamladı; crypto-erasure restore'u reddetti.
- Residency scheduler/object/index/export katmanlarında fail-closed çalıştı. Browser
  üç viewport'ta canlı API state'i, `401/403/409/206` güvenlik akışlarını doğruladı.
- İçerik tarayıcı 21 kaynağı taradı ve sıfır bulgu verdi. Acceptance report checksum'ı
  `70da6992e5f0340e52c1696ea5c5966e903263180ce27f40dc33d96b620224cb` oldu;
  geçici container, browser session, process, Codex home ve export archive kalmadı.
- Repo genelinde format, typecheck, 362 test, build ve SSR HTTP smoke geçti.

WP28 tamamlandı. Tek aktif iş paketi WP29'dur; WP29 kabul edilmeden WP30 başlatılmaz.

## WP29 nihai kabul sonucu

Karar: **Tamamlandı**

- Uygulama commit'leri `842708f` ve `81f2fd7` kabul edildi.
- Temiz implementation commit'inde gerçek `wp29:accept` kapısı; 7 hedefli test,
  reproducible build, OCI registry round-trip, Syft SBOM, Cosign imza/provenance,
  Gitleaks/Semgrep/Trivy/Hadolint/Conftest/pnpm audit ve compliance bundle üretimini
  tamamladı.
- Gerçek Codex `0.144.2` generated schema hash'i repository ile eşleşti. Bozuk şema
  `%4,76` unknown-event oranıyla `%1` eşiğini aştı ve rollout'u durdurdu; gerçek Codex
  app-server E2E başarıyla tamamlandı.
- PostgreSQL `17.5` migration ve durable rollout provalarında sekiz korunan domain'in
  checksum'ları rollback sonrasında değişmedi; veri kaybı `0`, concurrent promotion,
  stale/replay reddi, kill switch ve otomatik rollback doğrulandı.
- Kayıtlı acceptance report checksum'ı
  `716ddbd7824b6dfbd0fce8e5780e803685d2747b9261e719d2d48d60d16e56ac`;
  bağımsız koşunun evidence chain head'i
  `d4620173ec2e8b94cb0143fa29e3107d94930eeb25ec66e4602497c58e7f3d8c` ve cleanup
  sonucu `verified-zero` oldu.
- Repo genelinde format, typecheck, 369 test, production build ve SSR HTTP smoke geçti.

WP29 tamamlandı. Tek aktif iş paketi WP30'dur; WP30 bağımsız kabul edilmeden Faz 5
kapatılmaz.

## WP30-L nihai denetim sonucu

Karar: **Tamamlandı — local production-like engineering kabulü**

- Temiz detached `5195b8e` implementation worktree'sinde lab sıfırdan kuruldu;
  `pnpm wp30:local:accept` 10/10 yerel gate ile geçti.
- Gerçek ürün servisleri ve PostgreSQL/Redis/RabbitMQ/MinIO üzerinde ZAP/Nuclei,
  cross-tenant sınır, K6, chaos/recovery, durable rollout/halt/rollback ve iki viewport
  browser golden akışları çalıştırıldı.
- Bağımsız yeniden koşunun report SHA-256 değeri
  `276203dedc91d32e538f0c6e6ff7266c6d22fa02778eb021ea6bacf56dcd20ac` oldu; 22/22
  gömülü ham kanıtın hash'i ve bundle Ed25519 imzası doğrulandı.
- Acceptance cleanup sonrasında WP30 etiketli container, volume ve network sayıları
  sıfırdı. `pnpm verify`; format, typecheck, 45 dosyada 389 test, production build ve
  SSR HTTP smoke ile geçti.
- Sonuç `accepted-local-production-like`, `engineeringComplete:true`,
  `externalProductionReady:false`, `evidenceClass:local-operator` ve
  `targetScope:loopback-only` olarak tutuldu.

WP30-L ve Faz 5 engineering kapsamı tamamlandı; aktif iş paketi yoktur. Bağımsız
pentest/retest, gerçek production soak/chaos ve gerçek cohort rollout kanıtlarını
gerektiren WP30-E, production go-live öncesinde ayrı zorunlu kapıdır. Sonraki planlı
paket WP31'dir; açıkça aktive edilmeden başlatılmaz.

## Faz 6 plan aktivasyonu

Faz 6 open-source ve managed cloud planı
`docs/planning/phase-6-open-source-and-managed-cloud-plan.md` içinde WP31–WP35 olarak
tanımlıdır. Faz 5 mühendislik kapsamı WP30-L ile kapandığı için WP31 açıkça aktive
edilmiştir; WP32–WP35 bağımlılık sırasıyla beklemektedir ve WP31 bağımsız kabul
edilmeden WP32 başlatılmaz. WP30-E, production go-live öncesinde ayrı zorunlu kapı
olarak açık kalır; Faz 6 paketlerinin kabulünü değiştirmez ve onlarla karıştırılmaz.

Aktif iş paketi WP31'dir. Uygulama task'ına verilecek WP31 prompt'u hazırlanmış ve
yöneticiye teslim edilmiştir; teslimat `chore: prepare the repository for open source
release` commit'i ve bağımsız kabul denetimiyle kapanacaktır.
