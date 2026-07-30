# Perseverance — PoC Uygulama Planı

- Belge durumu: Aktif
- Plan sürümü: 1.0
- Başlangıç tarihi: 14 Temmuz 2026
- Kapsam: Faz 0 — tek kullanıcı, tek lokal workspace
- Ana mimari kaynak: `docs/architecture/perseverance-tasarim-spesifikasyonu.md`
- Teknoloji kararı: `docs/architecture/adr-0002-poc-technology-stack.md`
- İş paketi yönetim protokolü: `docs/planning/work-package-management.md`

## 1. Amaç

Bu PoC'nin amacı, gerçek ve pinli bir `codex app-server` ile çalışan en küçük uçtan uca Perseverance deneyimini kanıtlamaktır.

Kullanıcı web arayüzünden bir görev başlatabilmeli; Codex'in mesaj, reasoning summary, plan, komut, çıktı, diff ve approval olaylarını canlı görebilmelidir. Browser bağlantısı kesildiğinde turn workspace içinde devam etmeli, kullanıcı geri geldiğinde olaylar kayıpsız replay edilmeli ve aynı Codex thread'i sürdürülebilmelidir.

PoC şu teknik soruya cevap verir:

> Pinli bir Codex app-server sürümünden gelen olayları güvenli ve sürüm kontrollü biçimde normalize edip, dayanıklı bir timeline üzerinden canlı ve yeniden oynatılabilir olarak sunabiliyor muyuz?

## 2. Başarı ölçütleri

PoC aşağıdaki koşullar birlikte sağlandığında başarılı kabul edilir:

1. Web istemcisi üzerinden gerçek bir prompt gönderilebilir.
2. Platform yeni bir Codex thread ve turn başlatabilir.
3. Agent message, reasoning summary, plan, command output ve diff olayları canlı timeline'a ulaşır.
4. `item/completed` snapshot'ı geçici delta görünümünü doğru biçimde reconcile eder.
5. Command ve file approval istekleri kullanıcıya gerçek bağlamıyla gösterilir.
6. Aynı approval isteğine iki kez karar uygulanamaz.
7. Browser kapatılıp açıldığında eksik olaylar son sequence üzerinden replay edilir.
8. App-server yeniden başlatıldığında thread resume edilir veya açık bir recovery hatası üretilir.
9. Bilinmeyen Codex event/item türü sistemi çökertmez ve `codex.unknown` olarak korunur.
10. Üç golden görev senaryosu baştan sona geçer.

## 3. PoC kapsamı

### Dahil

- Tek kullanıcı
- Tek lokal workspace
- Lokal process olarak Workspace Agent ve Codex app-server
- Pinli Codex CLI `0.144.2`
- `stdio` üzerinden JSONL app-server protokolü
- TanStack Start web istemcisi
- Fastify control plane ve WebSocket gateway
- SQLite event/session deposu
- Raw mesaj ingest ve normalize timeline event'leri
- Thread start, turn start, steer, interrupt ve resume
- Command ve file approval
- Sequence tabanlı replay
- Responsive web arayüzü
- Unit, contract, golden-session ve dar entegrasyon testleri

### Hariç

- Gerçek multi-tenancy ve organizasyon/RBAC
- Production container veya mikro-VM izolasyonu
- Billing ve provider usage reconciliation
- Corpus, embedding ve hybrid retrieval
- Native iOS/Android uygulaması
- Kubernetes, multi-region ve disaster recovery
- Production secrets/KMS altyapısı
- Enterprise SSO/SCIM

PoC kodu güvenlik sınırlarını ihlal etmemelidir; ancak production izolasyon altyapısını tamamlaması beklenmez.

## 4. Teknoloji yığını

| Katman           | Teknoloji                                                               |
| ---------------- | ----------------------------------------------------------------------- |
| Monorepo         | pnpm workspace                                                          |
| Dil              | TypeScript 7                                                            |
| Runtime          | Node.js 24                                                              |
| Web              | TanStack Start, TanStack Router, TanStack Query, React 19, Vite         |
| Control plane    | Fastify                                                                 |
| Realtime         | Client-facing WebSocket                                                 |
| Workspace Agent  | Node.js/TypeScript child-process supervisor                             |
| Codex bağlantısı | `codex app-server`, `stdio`/JSONL                                       |
| Lokal veri       | SQLite (`node:sqlite`)                                                  |
| Sözleşmeler      | Codex generated TypeScript/JSON Schema + Zod domain event şemaları      |
| Test             | Vitest, fake app-server, real handshake smoke test, golden JSONL replay |

## 5. Sistem sınırları

```text
TanStack Start Web
        │ REST + WebSocket
        ▼
Fastify Control Plane
        │ process/RPC boundary
        ▼
Workspace Agent
        │ stdio JSONL
        ▼
Codex app-server
        │
        ├── Workspace dosya sistemi
        └── OpenAI/Codex hizmeti

Workspace Agent ──► Event Adapter ──► SQLite Event Store ──► Replay/Realtime
```

Temel sınırlar:

- Web istemcisi app-server'a doğrudan bağlanmaz.
- Control plane Codex protokol detaylarını UI'a sızdırmaz; normalize domain event sunar.
- Workspace Agent model orkestrasyonu yapmaz; process, RPC ve event adapter sorumluluğu taşır.
- Raw upstream mesaj ile normalize event ayrı kavramlardır.
- Secret veya auth credential event store'a yazılmaz.

## 6. Repository yapısı

```text
apps/web/                              TanStack Start istemcisi
services/control-plane/                REST ve realtime gateway
agents/workspace-agent/                App-server supervisor ve JSONL client
packages/codex-protocol-generated/     Generated upstream protokol
packages/domain-events/                Normalize event sözleşmeleri
packages/codex-event-adapter/          Upstream → domain dönüşümü
packages/event-store/                  SQLite append/replay katmanı
tests/golden-sessions/                  Golden JSONL senaryoları
docs/                                  Mimari kararlar ve planlar
```

## 7. İş paketleri

### WP0 — Repository ve protokol temeli

Durum: Tamamlandı

Çıktılar:

- pnpm/TypeScript monorepo
- Ortak typecheck, test, format ve build komutları
- Codex `0.144.2` sürüm pini
- `generate-ts` ve `generate-json-schema` otomasyonu
- Protocol manifest ve schema hash

Kabul kriterleri:

- `pnpm generate:codex-protocol` aynı Codex sürümünde yeniden çalışır.
- Farklı Codex sürümü sessizce schema üretemez.
- Generated dosyalar elle düzenlenmez.

### WP1 — Workspace Agent process ve RPC köprüsü

Durum: Tamamlandı

Teslim edilen çıktılar:

- App-server child-process yönetimi
- stdout JSONL ve stderr ayrımı
- Correlation ID tabanlı request/response eşleme
- Notification ve server request listener'ları
- Initialize/initialized handshake
- Fake app-server testi
- Gerçek app-server smoke testi
- Kontrollü restart/backoff
- Yapılandırılabilir request timeout
- Process health state
- Pending request rejection ve cleanup
- Fatal malformed JSON davranışı
- Pencere bazlı crash-loop limiti
- Graceful stop davranışı

Kabul kriterleri:

- Process kapanınca tüm pending request'ler kontrollü hata alır.
- Malformed JSON servis crash'i yerine açık protocol error üretir.
- Restart limiti crash loop'u engeller.

### WP2 — Normalize event adapter

Durum: Tamamlandı

Teslim edilen çıktılar:

- Versioned event envelope
- Agent message, reasoning summary ve plan deltaları
- Command proposed/output/completed
- Turn start/completed
- Diff updated
- Unknown event fallback
- File change proposed/completed
- Approval requested/resolved
- Tool/MCP lifecycle
- Token usage ve error mapping
- Completed snapshot reconciliation
- Raw event canonical checksum ve checksum öncesi redaction
- Generated schema tabanlı runtime validation
- Deterministik golden JSONL contract fixture'ları

Kabul kriterleri:

- Desteklenen her upstream event için contract fixture bulunur.
- Bilinmeyen enum veya event adapter'ı çökertmez.
- Final item, aynı item'a ait delta görünümünü yetkili snapshot'a dönüştürür.

### WP3 — Session, event store ve replay

Durum: Tamamlandı

Uygulanan çıktılar:

- Session ve Codex thread eşleme tablosu
- `BEGIN IMMEDIATE` içinde atomik workspace sequence tahsisi ve raw+normalize ingest
- Redakte inline raw event/artifact pointer ile idempotency key tabloları
- Scoped, limitli ve cursor metadata'lı REST replay
- Paylaşılan Zod REST/WebSocket sözleşmeleri
- High-water mark, connection-local live buffer ve monoton ack
- File-backed durability, migration, rollback, isolation ve replay/live yarış testleri

Kabul kanıtı:

- Duplicate ingest, rollback, durability, scope isolation ve idempotency testleri geçti.
- Replay/live yarış, reconnect cursor ve ack doğrulamaları geçti.
- Repository geneli `pnpm verify`; 4 test dosyasında 46 test, bütün package typecheck'leri ve web client/SSR production build ile geçti.

Kabul kriterleri:

- Duplicate ingest ikinci event üretmez.
- `afterSequence` replay sıralı ve eksiksizdir.
- Replay ile live stream arasında boşluk veya çift uygulama oluşmaz.

### WP4 — Gerçek thread ve turn akışı

Durum: Tamamlandı

İşler:

1. Workspace Agent instance registry oluştur.
2. Control plane üzerinden session oluşturma endpoint'i ekle.
3. `thread/start` cevabını session kaydıyla eşle.
4. Turn endpoint'i ve idempotency key desteği ekle.
5. `turn/start` isteğini Workspace Agent'a yönlendir.
6. App-server notification'larını adapter ve event store'a bağla.
7. Yeni event'leri aktif WebSocket subscriber'larına yayınla.
8. Web composer'ı gerçek endpoint'e bağla.
9. Timeline kartlarını normalize event türlerine göre render et.

Kabul kriterleri:

- Webden gönderilen prompt gerçek Codex turn başlatır.
- İlk normalize UI olayı prompt kabulünden sonra görünür.
- Turn tamamlanınca final agent mesajı timeline'da kalır.
- Aynı idempotency key ikinci turn başlatmaz.

Kabul kanıtı (14 Temmuz 2026):

- Fake app-server zinciri notification/server request → kalıcı adapter context → redakte raw+normalize event transaction → commit sonrası WebSocket olarak doğrulandı.
- Eşzamanlı aynı idempotency key tek `turn/start` üretti; farklı body hash conflict verdi.
- Gerçek Codex CLI 0.144.2 flow smoke'u final `TAMAM` agent mesajını aldı.
- Browser kontrolünde gerçek session/turn, final mesaj reconciliation, temiz console ve 390×844 taşmasız görünüm doğrulandı.
- Restart-safe ingest key'i tenant, workspace, runtime instance, process generation ve receive ordinal alanlarını içerir.
- File-backed iki control-plane instance regresyonu 12 unique/monotonic event, ayrı raw/session kayıtları ve ikinci authoritative completed mesajını doğruladı.
- Aynı ingest key'in farklı session/checksum kullanımı sequence veya row üretmeden `INGEST_KEY_CONFLICT` verdi.
- Delivery-error callback testi ilk handler hatasını gözlemledi ve sonraki iki delivery'nin işlendiğini doğruladı.
- Gerçek restart/browser kontrolünde ikinci session sequence 43–80 aralığında tamamlandı; son delta `.` olmasına karşın final kart `İKİNCİ OTURUM RESTART SONRASI AUTHORITATIVE TAM MESAJ.` gösterdi.
- `pnpm verify` kapsamında 4 test dosyasında 56 test, bütün typecheck'ler ve client/SSR build geçti.

Bağımsız kabul denetiminde bulunan ve giderilen kök neden:

- `workspaceId:processGeneration:receiveOrdinal` ingest anahtarı runtime restart'ında yeniden kullanılıyor; durable SQLite kayıtları yeni session mesajlarını eski session duplicate'i sayarak düşürüyor.
- Event store aynı anahtarın farklı session/checksum ile kullanımını conflict olarak reddetmiyor.
- Restart sonrası gerçek browser turn'ünde authoritative final event kayboldu ve yalnız son delta parçası göründü.
- Registry-scope `runtimeInstanceId`, store collision guard, restart-regression testi ve gözlemlenebilir delivery error hattı eklendi; blokaj kapatıldı.

### WP5 — Approval state machine

Durum: Tamamlandı

Uygulama notu: Approval kaydı raw+normalize ingest ile atomik yazılır; kararlar expected-version CAS ve Idempotency-Key ile korunur; response runtime instance/process generation'a bağlanır. REST, WebSocket ve responsive web kartı uygulanmış ve kabul edilmiştir.

Kabul sonucu: Gerçek smoke control-plane üzerinden durable pending/decision/resolved/terminal akışını kanıtladı. File diff lookup, runtime health/generation expiry, concurrent karar, WebSocket lifecycle ve terminal approval UI bağımsız olarak doğrulandı.

İşler:

- Server-initiated command/file approval yakalama
- Durable approval kaydı
- Pending approval endpoint ve WebSocket olayı
- Optimistic locking ve `expectedVersion`
- Accept, accept-for-session, decline ve cancel kararları
- App-server response ve resolved reconciliation
- Turn interrupt/crash halinde expire/supersede
- Mobil uyumlu sticky approval kartı

Kabul kriterleri:

- İki cihazın eşzamanlı kararından yalnız biri uygulanır.
- İkinci karar `APPROVAL_ALREADY_RESOLVED` alır.
- Kullanıcı komut, cwd, diff ve varsa ağ hedefini görmeden karar vermez.

### WP6 — Resume, reconnect ve recovery

Durum: Tamamlandı

Uygulama notu: Persistent tenant/workspace Codex home, schema v3 recovery modeli, `thread/read` → `thread/resume`, crash sonrası `outcome_unknown`, session detail/resume ve generated steer/interrupt uçları ile `/sessions/:sessionId` route’u doğrulandı. Gerçek iki-instance restart smoke aynı thread, monotonic sequence ve snapshot dedupe davranışını; browser denetimi route reload ile responsive recovery yüzeyini kanıtladı.

İşler:

- Kalıcı PoC `CODEX_HOME`
- `thread/read` ve `thread/resume`
- Browser reconnect cursor
- App-server restart sonrası session recovery
- `THREAD_NOT_RESUMABLE` hata modeli
- Turn interrupt ve steer

Kabul kriterleri:

- Browser yeniden açıldığında timeline eksiksiz gelir.
- App-server restart sonrası mevcut thread sürdürülebilir.
- Resume mümkün değilse kullanıcıya sessiz veri kaybı yerine açık recovery seçeneği sunulur.

### WP7 — Büyük çıktı ve timeline dayanıklılığı

Durum: Tamamlandı

İşler:

- Command output chunk index
- Bounded in-memory tail
- Artifact spill prototipi
- UI backpressure ve terminal kartı
- Completed snapshot reconciliation
- Uzun timeline sanallaştırma

Kabul kriterleri:

- 100 MB command output browser belleğini sınırsız büyütmez.
- Canlı görünüm son N KB'ı gösterebilir.
- Tam, redakte edilmiş çıktı artifact olarak erişilebilir.

### WP8 — Golden senaryolar ve PoC demosu

Durum: Tamamlandı

Golden görevler:

1. Repository inceleme ve final özet — yalnız okuma.
2. Küçük kod değişikliği, test ve diff — file change.
3. Ağ veya komut onayı isteyen görev — approval.

Ek arıza senaryoları:

- Browser bağlantısını kes/aç.
- App-server process'ini turn sonrasında yeniden başlat.
- Bilinmeyen event fixture'ı replay et.
- Aynı approval'a iki eşzamanlı karar gönder.

Kabul kriterleri:

- Üç golden görev web timeline'ında semantik olarak doğru görünür.
- Kayıp/çift event ve çift approval kararı oluşmaz.
- Demo temiz kurulum talimatıyla yeniden çalıştırılabilir.

Uygulama notu: `pnpm demo:smoke`; reconnect/unknown/concurrent-approval contract
regresyonlarını ve gerçek iki-instance recovery smoke'unu çalıştırır. Üç
`pnpm demo:golden:*` komutu gerçek app-server golden görevlerini yürütür. Geçici workspace, SQLite ve `CODEX_HOME` kapanışta
silinir. Temiz kurulum ve browser kabul adımları `docs/demo/poc-demo.md` içindedir.
Bağımsız kabul denetiminde generator determinism, doğrulama zinciri, gerçek golden
görevler, arıza smoke'ları, cleanup ve responsive browser görünümü doğrulanmıştır.

## 8. Önerilen teslimat sırası

| Dilim | İçerik                            | Beklenen sonuç                         |
| ----- | --------------------------------- | -------------------------------------- |
| D1    | WP4: Session + gerçek prompt/turn | Webden Codex'e görev gönderme          |
| D2    | WP2 tamamlama + timeline kartları | Mesaj, plan, komut ve diff görünümü    |
| D3    | WP5: Approval                     | Command/file karar akışı               |
| D4    | WP3/WP6: Replay + resume          | Browser ve app-server reconnect        |
| D5    | WP7: Büyük çıktı                  | Bounded terminal ve artifact prototipi |
| D6    | WP8: Golden demo                  | PoC exit değerlendirmesi               |

Her dilim bağımsız olarak typecheck, unit/contract test ve tarayıcı kontrolünden geçmeden sonraki dilim tamamlanmış sayılmaz.

## 9. Doğrulama stratejisi

### Her değişiklikte

```bash
pnpm verify
```

Bu komut şunları çalıştırır:

- Prettier kontrolü
- Tüm workspace typecheck
- Vitest testleri
- TanStack Start client ve SSR build

### Protokol değişikliğinde

```bash
pnpm generate:codex-protocol
pnpm verify
```

### Gerçek app-server handshake

```bash
pnpm --filter @perseverance/workspace-agent smoke:real
```

Gerçek smoke komutları opt-in'dir ve `pnpm verify` tarafından çalıştırılmaz. Her çalışma, yalnız mevcut auth/config dosyalarını symlink eden geçici bir `CODEX_HOME` kullanır; Codex Desktop task/session/state depoları bağlanmaz ve child process durduktan sonra geçici home silinir. Kullanıcının mevcut task'ları test cleanup işleminin parçası değildir.

### UI değişikliğinde

- Web ve control plane birlikte başlatılır.
- Ana sayfa browser'da açılır.
- Hata overlay'i ve console kontrol edilir.
- Control-plane bağlantı durumu doğrulanır.
- İlgili masaüstü ve mobil breakpoint gözden geçirilir.

## 10. Güvenlik kontrol noktaları

- API key, bearer token ve auth payload loglanmaz.
- Raw event saklama öncesi redaction uygulanır.
- App-server internetten doğrudan erişilebilir hale getirilmez.
- `thread/shellCommand` PoC kullanıcı yüzeyine açılmaz.
- Dosya yolları canonicalize edilmeden okunmaz veya yazılmaz.
- Approval resource bağlamı kullanıcıya açık gösterilir.
- Unknown action fail-open biçimde yürütülmez; yalnız olay olarak korunur.

## 11. Riskler ve azaltımlar

| Risk                                | Etki                       | Azaltım                                                         |
| ----------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Codex protokolü değişir             | Adapter ve UI kırılır      | Sürüm pini, generated schema, schema hash, golden replay        |
| Delta kaybı veya duplicate event    | Timeline yanlış görünür    | Monotonic sequence, idempotent client, completed reconciliation |
| App-server crash                    | Aktif görev kaybolur       | Supervisor, restart limiti, thread resume ve açık recovery      |
| Approval iki kez uygulanır          | Güvenlik ihlali            | Durable kayıt, optimistic locking, idempotent response          |
| Büyük terminal çıktısı              | Bellek/disk baskısı        | Bounded tail, chunking, artifact spill                          |
| Secret output'a düşer               | Veri sızıntısı             | Ingest öncesi redaction, fixture test corpus'u                  |
| TanStack Start RC davranışı değişir | Web build kırılır          | Sürüm pini ve production build doğrulaması                      |
| PoC sınırı production varsayılır    | Yanlış güvenlik beklentisi | Faz dışı maddeler ve ADR'lerde açık kapsam                      |

## 12. Karar gerektiren konular

PoC sırasında zorunlu olmayan ve sonraki ADR'lere bırakılan kararlar:

1. Production Workspace Agent dili: TypeScript, Go veya Rust.
2. Public beta runtime: sıkı container veya mikro-VM.
3. Platform-managed OpenAI key, BYOK veya karma model.
4. Production event omurgası: NATS JetStream veya Kafka/Redpanda.
5. PostgreSQL partition/RLS tasarımı.
6. Native mobil uygulamaya geçiş zamanı.

## 13. Definition of Done

Bir iş paketi ancak şu koşullarda tamamlandı sayılır:

- Sözleşme ve implementation birlikte güncellenmiştir.
- İlgili unit/contract testi vardır.
- `pnpm verify` geçer.
- Gerçek app-server bağımlılığı varsa smoke veya integration testi çalıştırılmıştır.
- UI etkisi varsa browser kontrolü yapılmıştır.
- Secret veya tenant sınırı etkisi gözden geçirilmiştir.
- Yol haritasındaki durum ve belge bağlantıları güncellenmiştir.
- Bilinen eksikler açıkça kaydedilmiştir.

## 14. Güncel sonraki adım

Faz 0, WP8 kabulüyle tamamlanmıştır. Faz 1 hedefi, WP9–WP12 kapsamı ve kabul kriterleri
`docs/planning/phase-1-alpha-plan.md` içinde tanımlanmıştır. Güncel denetim
`docs/planning/work-package-management.md` içinde tutulur.
