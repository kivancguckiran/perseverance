# Persistent Codex Workspace Agent Guide

Bu repository, `codex app-server` tabanlı kalıcı ve çok kiracılı Codex çalışma alanı ürünüdür. Kullanıcıyla varsayılan iletişim dili Türkçedir; kod, protokol alanları ve teknik terimler doğal İngilizce adlarıyla kalabilir.

## Doğruluk kaynakları

1. Ürün ve mimari için `docs/architecture/persistent-codex-workspace-tasarim-spesifikasyonu.md`.
2. Kabul edilmiş teknik kararlar için `docs/architecture/adr-*.md`.
3. Aktif uygulama sırası için `docs/planning/poc-roadmap.md`.
4. Çalışılan alt dizinde daha yakın bir `AGENTS.md` varsa o dosya önce gelir.

Spesifikasyon ile kod arasında uyuşmazlık görürsen sessizce yeni mimari icat etme. Dar ve geri alınabilir bir değişiklik yap; karar ürünün güvenlik sınırını, protokolünü veya veri modelini etkiliyorsa önce ADR ekle ya da mevcut ADR'yi güncelle.

## Mimari sınırlar

- Codex orkestrasyonunu yeniden yazma; gerçek, pinli `codex app-server` kullan.
- MVP'de Workspace Agent ile app-server arasında `stdio`/JSONL kullan. Deneysel WebSocket taşımasını çekirdek bağımlılık yapma.
- Workspace Agent bir adapter/supervisor'dır; model ajanı değildir.
- Upstream Codex mesajını önce raw envelope olarak koru, ardından versioned normalize event'e dönüştür.
- Bilinmeyen item, enum veya event decode crash üretmemeli; `codex.unknown` olarak korunmalıdır.
- UI delta'ları geçici kabul etmeli; completed item/snapshot geldiğinde reconcile etmelidir.
- Control plane ile workspace data plane'i süreç ve güvenlik sınırı olarak ayrı tut.
- Bir workspace içinde varsayılan olarak tek aktif turn varsayımını koru.

## Güvenlik değişmezleri

- Tenant kapsamı her domain kaydında ve storage key'inde açık olmalıdır.
- Secret, API key, bearer token veya hassas environment değeri event, log, trace, fixture ya da snapshot'a yazılmamalıdır.
- Dosya yollarını canonicalize et; `..`, symlink escape ve `/proc`/`/sys` erişimini reddet.
- App-server internete doğrudan açılmaz.
- Ağ ve dış yazma eylemlerinde default-deny ve kapsamı açık approval uygula.
- Approval çözümleme idempotent ve optimistic locking tabanlı olmalıdır; aynı istek iki kez uygulanmamalıdır.
- Gizli chain-of-thought'u isteme, saklama veya ürün özelliği gibi sunma. Yalnız protokolün açıkça sağladığı reasoning summary kullanılabilir.

## Uygulama yaklaşımı

- Önce Faz 0 dikey dilimi: process supervision → initialize → thread/turn → event adapter → replay → minimal timeline → approval.
- İlk aşamada control plane modüler monolith olabilir. Workspace Agent ve realtime/event adapter erken süreç sınırı olarak ayrı kalmalıdır.
- Codex protocol tiplerini elle kopyalamak yerine pinli binary'den `generate-ts`/`generate-json-schema` ile üret.
- Generated dosyaları elle düzenleme; üretim komutunu ve source version/schema hash bilgisini repository'de tut.
- Yeni normalize event eklerken type/schema, adapter mapping, unknown fallback ve contract fixture/test birlikte eklenmelidir.
- Büyük command output'u bellekte veya tek DB satırında sınırsız biriktirme; backpressure ve artifact spill tasarımını koru.

## Doğrulama

Değişiklik kapsamına göre en dar anlamlı kontrolleri çalıştır:

- Domain/adapter: unit test + golden fixture replay + typecheck.
- App-server köprüsü: gerçek pinli binary ile handshake/contract testi.
- Approval: durum makinesi, concurrent decision ve crash/recovery testi.
- Realtime: reconnect, sequence gap, duplicate event ve completed reconciliation testi.
- Dosya/Git: traversal, symlink escape ve dirty-state fixture testleri.
- UI: responsive timeline, reconnect ve küçük ekranda approval bağlamı.

Network, OpenAI hesabı, secret veya container runtime gerektiren testleri otomatik olarak uydurma veriyle geçmiş sayma; çalışmayan doğrulamayı finalde açıkça belirt.

## Git ve kapsam disiplini

- Kullanıcı istemedikçe commit, push, rebase veya destructive Git işlemi yapma.
- Mevcut kullanıcı değişikliklerini koru.
- Faz 0 için gerekmeyen billing, native mobile, corpus veya production infra'yı erken scaffold etme.
- Belgelenmiş açık ürün kararlarından birini keyfi biçimde kesinleştirme; gerekiyorsa ADR taslağı aç ve varsayımı görünür kıl.
