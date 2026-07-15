# ADR-0012: Provider-neutral runtime ve append-only usage ledger

- Durum: Kabul adayı
- Tarih: 15 Temmuz 2026
- Kapsam: Faz 2 WP13 provider platformu, model politikası ve maliyet temeli

## Bağlam

Faz 1 akışı Codex `app-server` protokolüne doğrudan bağlıdır. Faz 2'de Claude ve
Gemini adapter'ları eklenirken Codex orkestrasyonu yeniden yazılmamalı, sağlayıcıların
farklı lifecycle ve tool semantikleri sahte feature parity'ye çevrilmemeli ve mevcut raw
envelope + `codex.unknown` garantisi korunmalıdır. Aynı zamanda cumulative ve delta usage
olayları replay/restart sırasında çift maliyet üretmeden completed, failed ve interrupted
turn'lere bağlanmalıdır.

## Karar

- `@persistent-codex/provider-platform` paketindeki schema version 1; provider/model
  identity, capability matrix, session/turn lifecycle, interrupt, approval, normalized
  event, usage delta/snapshot ve typed provider error sözleşmelerinin ortak kaynağıdır.
  Capability değerleri `supported`, `unsupported` veya `degraded` olur; adapter eksik
  özelliği sessizce taklit etmez.
- Provider runtime adapter portu discovery, normalize event, interrupt ve approval
  sınırlarını tanımlar. Codex adapter'ı mevcut `CodexEventAdapter` davranışını korur ve
  pinli `app-server` `model/list` cevabını ortak model kataloğuna dönüştürür. Upstream
  model ID'si yalnız keşfedilmiş katalogdan gelir; generated Codex dosyaları elle
  değiştirilmez.
- `sol` ve `luna` ürün alias'ları config selector + discovered catalog ile çözülür.
  Selector açık model ID veya katalog default'u olabilir. Kodda gerçek provider model
  ID'si bulunmaz. Yeni conversation politikası `sol + medium`, title politikası
  `luna + none` olarak versioned contract sabitidir. Eşleşmeyen alias veya effort typed,
  actionable configuration error üretir.
- SQLite schema v9 session'a provider, requested policy, resolved model, reasoning effort
  ve immutable capability snapshot ekler; aynı alanları turn başlangıcında ayrı `turns`
  kaydına kopyalar. Legacy session'larda çözülmüş alanlar nullable kalır ve yeni turn
  başlamadan önce açık recovery/config hatası verir.
- `usage_ledger` public store API'sinde append-only'dir. Provider'ın reported counters'ı
  ile maliyete giren effective counters ayrı tutulur. `(tenant, workspace, session,
dedupe_key)` retry/replay'i tekilleştirir. `usage_cursors`, request/turn başına daha önce
  hesaba katılan miktarın mutable projection'ıdır: delta doğrudan eklenir; cumulative
  snapshot yalnız `max(snapshot - accounted, 0)` kadar effective delta üretir. Böylece
  delta/cumulative karışımı ve eski snapshot replay'i negatif ya da çift kullanım üretmez.
- Terminal lifecycle ayrı append-only satırdır ve `completed`, `failed`, `interrupted`
  sonuçlarını korur. Terminal usage yoksa summary `partial/unreconciled` ve estimated cost
  `null` döner; sıfır maliyet olarak sunulmaz.
- Estimated cost, integer micro-USD aritmetiğiyle versioned fiyat kataloğundan her usage
  satırı yazılırken hesaplanır. Katalog sürümü ledger satırına bağlanır; sonraki katalog
  değişikliği geçmiş tahmini mutasyona uğratmaz. Resmî provider sonucu ayrı
  `reconciliation` satırıdır; estimated tutarın üzerine yazılmaz.
- Canlı billing/admin entegrasyonları `ProviderCostReconciliationPort` arkasındadır ve
  WP13 yalnız fixture kullanır. Inference credential'ı bu portun admin yetkisi gibi kabul
  edilmez.
- Usage API yalnız tenant/workspace/session ve opsiyonel turn scope'unda counters,
  lifecycle sonucu, completeness/reconciliation durumu ve cost tutarlarını döndürür.
  Prompt, model cevabı, reasoning, command output, secret veya credential reference
  ledger ve response şemasında yer alamaz.

## Sonuçlar

Claude/Gemini process adapter'ları, background execution recovery, canlı admin API
reconciliation, bütçe/quota enforcement ve maliyet UI'ı bu kararın uygulama kapsamı
dışındadır. `usage_cursors` ledger'ın doğruluk kaynağı değil, append-only satırlardan
yeniden kurulabilen idempotency projection'ıdır. Provider katalog veya fiyat config'i
eksikse yeni iş görünür configuration error ya da partial/unpriced kayıt üretir; sistem
model ID veya sıfır maliyet tahmin etmez.

WP14 accounting finalization ADR-0013 ile eklenmiştir: cumulative Codex snapshot'ları
`tokenUsage.total` üzerinden stable ingest key ile yazılır; durable run terminal geçişi,
turn sonucu ve terminal ledger kaydı aynı transaction'da finalize edilir.
