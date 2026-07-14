# ADR-0001: Codex entegrasyonu için app-server kullanımı

- Durum: Kabul edildi
- Tarih: 2026-07-14

## Bağlam

Ürün; kalıcı workspace, canlı olay akışı, thread resume, turn yönetimi ve kullanıcı approval'larını web/mobil istemciye taşımalıdır. Terminal ekranı ayrıştırmak bu semantiği kaybeder. Codex orkestrasyonunu platform içinde yeniden uygulamak da ürün kapsamını ve uyumluluk riskini gereksiz büyütür.

## Karar

Her izole workspace içinde gerçek ve pinli bir `codex app-server` çalıştırılacaktır.

- Workspace Agent app-server'ı child process olarak denetler.
- MVP taşıması `stdio` üzerinden JSONL'dir.
- Upstream protokol tipleri çalıştırılan Codex sürümünden üretilir.
- Her upstream mesaj raw kayıt ve kararlı normalize event görünümüne ayrılır.
- Web/mobil istemci app-server'a doğrudan bağlanmaz; platform API ve realtime gateway üzerinden çalışır.
- Deneysel upstream özellikler capability/feature flag arkasında tutulur.

## Sonuçlar

Olumlu sonuçlar:

- Thread, turn, item, delta ve approval semantiği korunur.
- Codex'in model ve tool orkestrasyonu yeniden yazılmaz.
- Mobil reconnect ve olay replay için kararlı platform modeli kurulabilir.

Maliyetler ve yükümlülükler:

- Codex sürümü, generated schema ve adapter birlikte pinlenmelidir.
- Unknown event toleransı ve golden replay testleri zorunludur.
- App-server process yaşam döngüsü ve `CODEX_HOME` kalıcılığı operasyonel sorumluluktur.

## Reddedilen seçenekler

- Terminal/TUI ekran kazıma: approval ve item semantiğini güvenilir taşımaz.
- MVP'de doğrudan app-server WebSocket: deneysel yüzeyi üretim bağımlılığı yapar.
- Codex orkestrasyonunu yeniden yazmak: uyumluluk, güvenlik ve bakım yükünü büyütür.
