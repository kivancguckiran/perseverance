# Perseverance — WP8 PoC Demo Rehberi

Durum: Uygulandı / bağımsız kabul bekliyor
Hedef sürümler: Node.js 24, pnpm 9.15.3, Codex CLI 0.144.2

## 1. Temiz kurulum

Repository kökünde çalışın. Codex CLI hesabının oturum açmış olması gerekir; smoke
yalnız `auth.json` ve `config.toml` dosyalarını geçici `CODEX_HOME` içine symlink eder.
Kişisel Codex task/session/state verisi kopyalanmaz veya kanıta yazılmaz.

```bash
pnpm install --frozen-lockfile
pnpm generate:codex-protocol
git diff --exit-code -- packages/codex-protocol-generated
pnpm verify
pnpm demo:smoke
pnpm demo:golden:read-only
pnpm demo:golden:change
pnpm demo:golden:approval
```

`demo:smoke` reconnect, unknown ve approval contract regresyonlarıyla gerçek
iki-instance restart/resume smoke'unu çalıştırır. Sonraki üç kısa komut gerçek golden
görevleri birbirinden izole app-server process'lerinde yürütür.
Çıktı yalnız sentetik tenant/workspace kimlikleri, event türleri, sequence özetleri ve
cleanup boolean değerleri içerir. Prompt, auth payload, secret ve model çıktısı kanıt
JSON'una alınmaz. Her golden sonuç; `contiguousSequences`, `monotonicSequences`,
`commandExitCodes`, `approvalLifecycle` ve gerekiyorsa `approvalRace` alanlarını içerir.
Approval kanıtındaki `upstreamApprovalResponses` tam olarak `1` olmalıdır. Son `cleanup`
nesnesindeki app-server, SQLite/WAL/SHM, artifact, workspace, geçici Codex home ve kök
dizin boolean değerlerinin tamamı `true` olmalıdır.

## 2. Golden görevlerde beklenen kanıt

| Görev                | Zorunlu timeline semantiği                                                            | Ek kontrol                                       |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Salt-okunur inceleme | `turn.started`, varsa reasoning/plan, agent message, `turn.completed`                 | Fixture dosyaları değişmez                       |
| Küçük değişiklik     | file change veya `diff.updated`, command output/completed, agent final, terminal turn | `subtract` eklenir ve `node math.test.mjs` geçer |
| Approval             | command proposal/output, `approval.requested`, durable resolved kart, terminal turn   | Yarışta HTTP 200 + 409 ve tek kazanan            |

Reasoning summary ve plan Codex tarafından yayımlanırsa timeline bunları ayrı semantik
kartlar olarak gösterir; protokolün sağlamadığı bir reasoning içeriği uydurulmaz.

## 3. Arıza senaryoları

1. Reconnect: test WebSocket'i sequence 3'te kapatır, event 4'ü yazar ve cursor 3 ile
   yeniden bağlanır. Replay yalnız sequence 4'ü döndürür.
2. Restart/resume: ilk gerçek turn tamamlanınca ilk control-plane/app-server kapanır.
   İkinci instance `thread/read` → `thread/resume` yapar; Codex thread ID değişmez,
   sequence ilerler ve snapshot tekrarlanmaz.
3. Unknown replay: `tests/golden-sessions/unknown.input.jsonl` event store'a alınır ve
   REST replay'de `codex.unknown` olarak görünür; sonraki işlemler devam eder.
4. Concurrent approval: aynı version için iki karar paralel gönderilir. Yalnız biri
   200 alır, diğeri 409 `APPROVAL_ALREADY_RESOLVED` alır ve tek karar kazanır.

## 4. Gerçek web demo ve browser kabulü

Bir terminalde izole runtime yollarıyla uygulamayı başlatın:

```bash
DEMO_ROOT="$(mktemp -d /tmp/persistent-codex-web-demo.XXXXXX)"
EVENT_DATABASE_PATH="$DEMO_ROOT/events.sqlite" \
CODEX_HOME_ROOT="$DEMO_ROOT/codex-homes" \
ARTIFACT_ROOT="$DEMO_ROOT/artifacts" \
WORKSPACE_CWD="$PWD" \
APPROVAL_POLICY=untrusted \
pnpm dev
```

`http://localhost:3000` adresini açın. Composer üzerinden yukarıdaki üç görevin
eşdeğerlerini sırayla gönderin; approval kartında karar verin. Her session URL'sini
not ederek reload/reconnect sonrasında aynı timeline'ın kaldığını doğrulayın.

Desktop 1280×720 ve mobil 390×844 için:

- Sayfa ve session route HTTP 200 ile yüklenir; boş sayfa yoktur.
- Console error/warning, `.vite-error-overlay` veya framework overlay yoktur.
- Agent, reasoning/plan varsa, command, diff, approval ve terminal kartlar doğru
  başlık/içerikle görünür.
- `document.documentElement.scrollWidth <= window.innerWidth` doğrudur.
- Mobilde approval bağlamı ve karar butonları görünür, yatay taşma yoktur.

## 5. Cleanup

Önce `pnpm dev` sürecini `Ctrl-C` ile kapatın, açılan demo tab'larını kapatın; sonra:

```bash
rm -rf "$DEMO_ROOT"
git status --short
```

Birleşik smoke önce control-plane/app-server'ı, ardından event store'u kapatır; en son
geçici workspace, SQLite/WAL/SHM, artifact ve Codex home kökünü siler. Evidence JSON'u
bu sıra tamamlandıktan sonra yazılır ve bütün cleanup alanları `true` olmalıdır.

## 7. Kabul kanıtı — 14 Temmuz 2026

Redakte edilmiş gerçek browser denetimi `http://localhost:3000` üzerinde, izole SQLite,
artifact ve persistent Codex home kökleriyle gerçekleştirildi.

- Salt-okunur görev gerçek web composer'dan gönderildi; command output, authoritative
  iki maddelik agent finali ve `turn.completed` kartı göründü.
- Değişiklik görevi geçici `wp8-browser-demo.mjs` üzerinde yürütüldü. File approval,
  dosya değişikliği, diff, `node wp8-browser-demo.mjs` command kartı, exit code 0 final
  özeti ve terminal turn timeline'da görüldü. Geçici dosya denetim sonunda silindi.
- Approval görevi `printf WP8_BROWSER_APPROVAL` komutuyla pending kart üretti. Browser
  kararı sonrası aynı kart resolved kaldı ve pending kart sayısı sıfıra indi.
- Session URL'si reload edildi; aynı session ve durable timeline sequence 278'e kadar
  tekrar yüklendi, change diff/final/terminal kartları kaybolmadı.
- Desktop 1280×720: `scrollWidth - innerWidth = 0`, overlay yok, console warning/error
  listesi boştu.
- Mobil 390×844: `scrollWidth - innerWidth = 0`, overlay yok ve resolved approval kartı
  görünürdü.
- In-app browser tab'ları finalize edilerek kapatıldı; dev process'leri durduruldu;
  geçici SQLite, artifact, Codex home ve browser demo runtime kökü silindi.

Kanıt hiçbir auth payload, secret, kişisel Codex task içeriği veya ham model çıktısı
içermez; yalnız sentetik session bağlamı ve UI semantik sonuçları kaydedilmiştir.

## 6. Sorun giderme

- `codex: command not found`: Codex CLI 0.144.2'yi kurun ve `codex --version` ile
  doğrulayın.
- Authentication hatası: normal Codex home içinde yeniden oturum açın; credential'ı
  environment'a veya loga yapıştırmayın.
- Timeout: `CODEX_POC_DEMO_TIMEOUT_MS=600000 pnpm demo:smoke` kullanın.
- 3000/3100 portu doluysa önce eski demo süreçlerini kapatın; farklı port web proxy
  ayarını da gerektirir.
- Generated drift oluşursa generated dosyayı elle düzeltmeyin; pinli binary ve manifest
  uyuşmasını kontrol edip generator'ı yeniden çalıştırın.
