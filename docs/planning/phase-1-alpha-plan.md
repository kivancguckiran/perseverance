# Faz 1 — Tek kiracılı alfa uygulama planı

- Plan durumu: Aktif
- Plan tarihi: 14 Temmuz 2026
- Aktif iş paketi: WP10 — Uygulandı / kabul bekliyor
- Kaynak spesifikasyon: `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`

## 1. Amaç

Faz 0 protokol kanıtını tek kullanıcının günlük lokal kullanımına uygun, güvenli biçimde
başlatılabilen ve operasyonel olarak anlaşılabilen tek kiracılı bir alfaya dönüştürmek.
Faz 0'da tamamlanan app-server supervision, durable timeline, replay/resume, approval,
bounded artifact ve responsive timeline yeniden uygulanmayacak; Faz 1 bu temelin
kullanılabilirlik ve işletim boşluklarını kapatacaktır.

## 2. Exit kriteri

Faz 1 ancak aşağıdaki koşullar birlikte sağlandığında tamamlanır:

- Temiz kurulumdan tek desteklenen komutla alfa başlar; auth/config eksikleri secret
  sızdırmadan ve uygulanabilir yönergeyle gösterilir.
- Browser, control-plane veya app-server yeniden başladığında aktif session ve geçmiş
  sequence gap, duplicate authoritative event veya sessiz veri kaybı olmadan sürer.
- Kullanıcı yakın session'lara dönebilir; workspace Git status, diff ve sınırlı log
  görünümünü güvenli, salt-okunur bir yüzeyden inceleyebilir.
- Kritik kullanıcı ve runtime eylemleri durable audit zincirinde izlenebilir; temel
  health ve metrics arıza durumunu doğru gösterir.
- Temiz kurulum, upgrade/restart, auth failure, approval, büyük çıktı, Git ve recovery
  senaryoları tekrarlanabilir alfa kabul paketinde geçer.

## 3. Kapsam sınırı ve değişmezler

- Faz 1 tek kullanıcı, tek tenant ve server-configured lokal workspace ile sınırlıdır.
- TanStack Start/Router/Query, Fastify, TypeScript, SQLite ve pinli Codex `0.144.2`
  teknoloji kararları korunur.
- Credential içeriği browser'a, API response'una, event/audit store'a, metric label'a,
  fixture'a veya log'a yazılmaz.
- Workspace path'i browser'dan alınmaz; Git ve Codex işlemleri canonical server-owned
  workspace sınırında çalışır.
- Multi-tenant org/user/RBAC, scheduler, production container/mikro-VM izolasyonu,
  KMS/Vault, billing, corpus, native mobile, push ve multi-region Faz 1 dışındadır.
- Her zaman yalnız bir aktif iş paketi bulunur. Her paket bağımsız kabulden önce
  `Kabul bekliyor`, kabulden sonra `Tamamlandı` olur ve tek açıklayıcı commit üretir.

## 4. İş paketi özeti

| Paket | Durum                      | Hedef                                                                |
| ----- | -------------------------- | -------------------------------------------------------------------- |
| WP9   | Tamamlandı                 | Güvenli alfa başlatma, auth bootstrap ve actionable readiness        |
| WP10  | Uygulandı / kabul bekliyor | Yakın session navigasyonu ile salt-okunur Git status/diff/log yüzeyi |
| WP11  | Bekliyor                   | Durable audit zinciri, liveness/readiness ve bounded temel metrics   |
| WP12  | Bekliyor                   | Tek kiracılı alfa hardening, runbook ve release kabulü               |

## 5. WP9 — Alfa başlatma ve auth bootstrap

### Hedef

Manuel ve hataya açık environment kurulumu nedeniyle oluşan `401`/reconnect döngüsünü
önlemek; mevcut Codex CLI login'ini credential kopyalamadan kullanan, eksik veya bozuk
auth durumunu turn başlamadan açıklayan tek desteklenen lokal alfa başlatma akışı kurmak.

### Yapılacak işler

- Server-owned alfa config/preflight modeli ve shared runtime sözleşmelerini tanımla.
- Provisioning source çözümlemesini explicit config ve yalnız lokal alfa için güvenli,
  belgelenmiş varsayılanla yap; yalnız `auth.json` ve `config.toml` allowlist'ini koru.
- Source/target path, permission, symlink escape, Codex binary sürümü, workspace,
  SQLite ve artifact root readiness kontrollerini ekle.
- App-server initialize sonrasında generated resmi account/auth yüzeyiyle login
  readiness'ini doğrula; response yalnız redakte durum ve uygulanabilir recovery taşısın.
- Liveness'tan ayrı typed readiness endpoint'i ve web setup/recovery durumu ekle.
- Upstream `401`/auth failure'ı `AUTH_REQUIRED` olarak sınıflandır; sınırsız reconnect
  kartı üretmeden turn/session'ı açık ve yeniden denenebilir recovery durumuna getir.
- Tek desteklenen `pnpm alpha:dev` başlangıç komutu, örnek config ve troubleshooting
  rehberi ekle.
- Geçerli mevcut ChatGPT/Codex CLI login'iyle API key gerektirmeyen gerçek smoke ekle.

### Kapsam dışı

- Platform-managed API key, BYOK, browser login formu, OIDC, org/user/RBAC.
- Production secret manager veya multi-tenant credential dağıtımı.
- Codex sürüm yükseltmesi.

### Kabul kriterleri

- Credential yokken session/turn başlamaz; UI ve readiness endpoint'i secret/path
  sızdırmadan `codex login` yönlendirmesi gösterir.
- Geçerli mevcut Codex login'iyle `pnpm alpha:dev` sonrasında gerçek turn ek API key
  ayarı olmadan tamamlanır.
- Upstream 401, bounded retry sonrasında tek typed `AUTH_REQUIRED` recovery sonucu
  üretir; tekrar eden reconnect kartlarıyla timeline'ı doldurmaz.
- Eksik/unsafe provisioning source, değiştirilmiş symlink, yanlış Codex sürümü ve
  yazılamayan runtime path'leri deterministik preflight hatası üretir.
- Auth/config içeriği API, event, audit, metric, stdout/stderr veya browser'a sızmaz.
- Desktop ve 390×844 görünümde setup, retry ve hazır durumları erişilebilir görünür.

### Zorunlu doğrulama

- Hedefli unit/contract/integration testleri
- Auth yok, unsafe source, yanlış sürüm ve 401 fixture/smoke senaryoları
- Gerçek mevcut Codex login'iyle opt-in auth + turn smoke
- `pnpm verify`
- `pnpm alpha:dev` temiz kurulum browser kontrolü
- `git status --short`

### Teslimat commit'i

`feat: add alpha auth bootstrap and readiness`

## 6. WP10 — Workspace ve Git görünürlüğü

### Bağımlılık

WP9 tamamlanmış olmalıdır.

### Hedef

Kullanıcının yakın session'lara URL saklamadan dönebildiği ve Codex'in workspace'te
yaptığı değişiklikleri Git doğruluk kaynağı üzerinden inceleyebildiği responsive alfa
workspace yüzeyi oluşturmak.

### Yapılacak işler

- Scoped, sayfalı yakın session listesi ve session durum/navigasyon sözleşmelerini ekle.
- Workspace Agent sınırından salt-okunur Git snapshot üret: branch/HEAD, porcelain-v2
  status, staged/unstaged/untracked özet, rename/binary bilgisi, bounded diff ve sınırlı
  log.
- Git komutlarını shell interpolation olmadan, timeout/output limitli ve canonical
  server-owned cwd ile çalıştır; no-repo/submodule/worktree durumlarını typed taşı.
- Turn öncesi/sonrası snapshot'ları session/turn ile durable ve idempotent bağla.
- Büyük diff'i WP7 artifact hattına taşı; preview ve download scope'unu koru.
- Web'e yakın session navigasyonu, Git status/diff/log paneli, refresh/stale/error
  durumları ve mevcut event diff'iyle Git snapshot ilişkisini ekle.

### Kapsam dışı

- Commit, push, pull, checkout, branch oluşturma/silme ve remote credential yönetimi.
- Snapshot restore veya merge conflict çözümü.
- Birden fazla workspace seçimi.

### Kabul kriterleri

- Clean/dirty repo, staged/unstaged/untracked, rename, binary ve no-repo fixture'ları
  doğru ve deterministik sonuç verir.
- Değişiklik yapan gerçek turn'de before/after snapshot, diff ve commit HEAD doğru
  session/turn'a bağlıdır; reload sonrası aynı görünür.
- Büyük diff browser/server belleğini sınırsız büyütmez ve scoped artifact olur.
- Path traversal, symlink escape, keyfi git argümanı ve Git mutation mümkün değildir.
- Desktop ve mobilde yakın session seçimi ile Git paneli yatay taşma olmadan çalışır.

### Zorunlu doğrulama

- Git fixture unit/integration test matrisi
- Gerçek küçük değişiklik + targeted test + before/after Git smoke
- Session listesi pagination/isolation/reload testleri
- `pnpm verify` ve desktop/390×844 browser kontrolü
- `git status --short`

### Teslimat commit'i

`feat: add alpha workspace and Git visibility`

## 7. WP11 — Audit ve temel metrics

### Bağımlılık

WP9 ve WP10 tamamlanmış olmalıdır.

### Hedef

Tek kiracılı alfada ne olduğunu secret veya yüksek cardinality üretmeden açıklayacak
durable audit zinciri ile temel operasyonel sağlık ve performans sinyallerini sağlamak.

### Yapılacak işler

- Append-only durable audit sözleşmesi/store'u ekle: session/turn lifecycle, approval
  kararı, auth state transition, runtime restart/recovery, steer/interrupt ve Git
  snapshot erişimi.
- Actor, action, outcome, timestamp, correlation/request/trace ve scope alanlarını
  standardize et; payload yerine redakte metadata tut.
- Scoped ve sayfalı audit query endpoint'i ile minimal responsive audit görünümü ekle.
- API latency/error, turn duration/outcome/token, approval wait, reconnect/replay lag,
  app-server restart/crash-loop, artifact byte/status ve runtime/disk sağlık metriklerini
  bounded-cardinality biçimde üret.
- `/healthz` liveness, `/readyz` dependency readiness ve makinece okunur metrics
  endpoint'lerini ayır; test clock ve injectable recorder kullan.
- Retention/boyut limitini ve SQLite contention davranışını belgeleyip test et.

### Kapsam dışı

- Harici OpenTelemetry/Prometheus/Grafana kurulumu, SIEM exportu ve alerting servisi.
- Billing usage ledger veya resmi provider faturası reconciliation'ı.
- Multi-tenant admin/authorization modeli.

### Kabul kriterleri

- Golden read-only/change/approval/recovery akışları beklenen sıralı audit zincirini
  üretir; concurrent approval yalnız tek başarılı karar kaydı oluşturur.
- Restart sonrası audit kalır; failed auth, runtime restart ve recovery health/metric
  durumuna doğru yansır.
- Prompt, model çıktısı, diff, credential, path ve yüksek cardinality kimlikleri metric
  label'larına veya audit metadata'sına sızmaz.
- Health/readiness bağımlılık kaybı ve iyileşmesini deterministik gösterir.
- Audit pagination/isolation ve retention davranışı bounded kalır.

### Zorunlu doğrulama

- Audit transaction/concurrency/reopen/migration testleri
- Deterministik metric/health failure-recovery testleri
- Golden ve auth/restart integration smoke
- `pnpm verify` ve responsive browser kontrolü
- `git status --short`

### Teslimat commit'i

`feat: add durable audit and alpha metrics`

## 8. WP12 — Tek kiracılı alfa hardening ve kabul

### Bağımlılık

WP9–WP11 tamamlanmış olmalıdır.

### Hedef

Faz 1 exit kriterini temiz kurulumdan tekrarlanabilir biçimde kanıtlamak, günlük lokal
kullanım için runbook ve release gate hazırlamak.

### Yapılacak işler

- Temiz install/upgrade/start/stop, persistent path, backup/restore veya açık recovery,
  cleanup ve troubleshooting runbook'unu tamamla.
- Deterministik fake-runtime soak ile kısa gerçek-model canary katmanlarını ayır.
- Browser/control-plane/app-server restart, auth expiry/recovery, disk pressure,
  artifact cleanup, uzun timeline/reconnect, approval race, Git snapshot ve audit/metric
  tutarlılığı senaryolarını birleşik alfa kabul komutuna bağla.
- Process/file descriptor, SQLite/WAL, CPU/RAM ve disk büyümesi için ölçülebilir lokal
  alfa eşikleri belirle; leak ve orphan cleanup doğrula.
- Desktop ve 390×844 gerçek browser acceptance, release checklist, bilinen sınırlamalar
  ve Faz 1 exit raporu hazırla.

### Kapsam dışı

- Production SLO/SLA iddiası, multi-region DR ve public beta deployment.
- Multi-tenant security/pentest ve production runtime isolation.
- Faz 2 özellik implementasyonu.

### Kabul kriterleri

- Temiz kurulumdan tek komutla alfa çalışır ve birleşik kabul paketi yeniden üretilebilir.
- Browser/control-plane/app-server restartlarında aynı session/thread ve geçmiş kayıpsız
  sürer; sequence gap veya duplicate authoritative event oluşmaz.
- Auth failure uygulanabilir recovery gösterir; Git, audit ve metrics restart sonrasında
  birbirleriyle tutarlı kalır.
- Bounded kaynak eşikleri, artifact/disk cleanup ve process leak kontrolleri geçer.
- Desktop/mobil golden görevler, approval ve reload/reconnect semantiği doğru görünür.
- Bütün doğrulamalar sonrası geçici process, tab, DB, artifact ve Codex home temizlenir.

### Zorunlu doğrulama

- `pnpm install --frozen-lockfile`
- İki ardışık protocol generation ve drift kontrolü
- `pnpm verify`
- Faz 1 birleşik deterministic soak ve gerçek canary komutları
- Temiz install/upgrade/restart/backup-recovery provası
- Desktop ve 390×844 browser kabulü
- `git status --short`

### Teslimat commit'i

`feat: complete single-tenant alpha acceptance`

## 9. Paket geçiş kuralı

WP10 tek aktif pakettir. WP11 yalnız WP10; WP12 yalnız WP11 bağımsız denetimde tamamen
kabul edildikten sonra aktif edilebilir. Eksik paket
için yeni pakete geçilmez, yalnız kabul engellerini kapatan düzeltme prompt'u üretilir.
