# ADR-0031 — Açık kaynak lisansı ve public-release güvenlik sınırları

- Durum: Kabul edildi
- Tarih: 2026-07-23
- Kapsam: WP31

## Bağlam

Faz 6 planı repository'yi iki dağıtım modeliyle yayımlamayı hedefler: self-hosted
community edition ve ticari Managed Cloud. Halka açılmadan önce üç karar
gereklidir: kaynak kodun lisansı, Git history dahil secret güvenliği ve
dependency lisans/supply-chain sınırları. Lisans kararı community katkısını,
hosted rakip riskini ve ileride ticari lisanslama esnekliğini birlikte etkiler.

## Değerlendirilen seçenekler

### Apache-2.0

- En geniş community ve kurumsal benimseme; patent grant içerir.
- Hosted rakip riskine karşı koruma sağlamaz: büyük bir bulut sağlayıcı ürünü
  değişikliklerini paylaşmadan rakip bir managed service olarak sunabilir.
- Managed Cloud gelir modelini tek farklılaştırıcı olarak operasyon kalitesine
  bırakır; Faz 6'nın ticari hedefiyle çelişir.

### AGPLv3 (tek lisans)

- Kodu ağ üzerinden servis olarak sunan herkes (SaaS dahil) değişikliklerini
  aynı lisansla açmak zorundadır (AGPL §13). Hosted rakip, ürünü kapalı
  fork'layarak farklılaşamaz.
- Self-hosted kullanıcı için kısıt yoktur: kurar, değiştirir, kendi
  değişikliklerini yalnız servis sunuyorsa paylaşır.
- Bazı kurumsal kullanıcılar AGPL bağımlılığından kaçınır; ancak bu ürün bir
  kütüphane değil uçtan uca uygulamadır ve başka ürünlere gömülmez — AGPL'nin
  tipik kurumsal itirazı (kütüphane bulaşması) burada zayıftır.
- Copyright tek elde kaldığı sürece ileride ticari/ikili lisans eklenebilir.

### Dual-license (AGPLv3 + ticari)

- En yüksek ticari esneklik; AGPL yükümlülüğünü istemeyen şirketlere ticari
  lisans satılabilir.
- Bugünden CLA süreci, lisans satış operasyonu ve ayrı ticari metin gerektirir.
  Henüz dış katkıcı ve ticari talep yokken bu yönetim yükü erken optimizasyondur.

## Karar

### Lisans: AGPL-3.0-only

Repository **GNU Affero General Public License v3.0 only (AGPL-3.0-only)** ile
lisanslanır. Kanonik SPDX metni `LICENSE` dosyasındadır; telif beyanı `NOTICE`
içinde **The Perseverance Authors** adına tutulur. "only"
tercihi, gelecekteki bir AGPLv4'ün koşullarını şimdiden kabul etmemek içindir.

Dual-license bugün açılmaz; ancak seçenek bilinçli olarak korunur:

- Katkılar `CONTRIBUTING.md` içinde tanımlanan **DCO (Developer Certificate of
  Origin)** sign-off'u ile alınır; inbound=outbound (AGPL-3.0-only) kuralı
  geçerlidir.
- Dış katkı kabul edilmeye başlandıktan sonra ikili lisansa geçiş tüm
  katkıcıların onayını gerektirir. Ticari lisanslama ihtimali somutlaşırsa CLA,
  ilk dış katkıdan önce ayrı bir kararla devreye alınmalıdır. Bu risk bilinçli
  kabul edilmiştir.

### Dependency lisans politikası

`infra/release/wp29-license-policy.v1.json` tek doğruluk kaynağı kalır ve
`projectLicense: "AGPL-3.0-only"` alanıyla genişletilir. Yasak liste (AGPL,
GPL, SSPL bağımlılıkları) bilinçli olarak korunur: AGPLv3 bir proje hukuken
GPLv3/AGPLv3 bağımlılık kullanabilirdi, ancak bağımlılık ağacını permissive
tutmak (a) ileride ikili/ticari lisans seçeneğini açık tutar, (b) Managed
Cloud dağıtımında lisans analizini basitleştirir. Mevcut 344 paketlik ağaç
tamamen permissive lisanslıdır; politika mevcut durumu kilitler.

### Secret güvenliği ve history stratejisi

WP31 taraması working tree ve tam Git history üzerinde
`infra/release/wp31-gitleaks.toml` (wp29 konfigürasyonunun genişletilmiş
üst kümesi) ile çalışır. Tarama sonucu: history'de **gerçek secret
bulunmamıştır**; tüm bulgular kendini fixture/lab-değeri olarak etiketleyen
test sabitleridir ve konfigürasyondaki allowlist'te gerekçeleriyle listelenir.
Bu nedenle **history rewrite yapılmaz**; mevcut commit zinciri ve hash'ler
public mirror'a olduğu gibi taşınabilir. İleride history'de gerçek bir secret
bulunursa öncelik rotate-and-document'tir; rewrite yalnız rotate edilemeyen
sızıntılar için yönetici kararıyla uygulanır.

Lokal lab/secret dizinlerinin (`.env*`, `.wp29/`, `.wp30/`, `.wp31/`,
`.codex-home/`, `.runtime/`, `artifacts/`, `tmp/`) gitignore kapsamı
`scripts/wp31-public-preflight.test.ts` ile testle kanıtlanır ve
`pnpm release:public-preflight` her koşuda doğrular.

### Public-release gate

`pnpm release:public-preflight` (`scripts/wp31-public-preflight.ts`) tek
deterministik gate altında şunları koşar: working tree + history secret
taraması, dependency lisans gate'i, deterministik SBOM/lisans envanteri üretimi
ve drift kontrolü, zorunlu hijyen dosyalarının varlığı ve temiz checkout'ta
`pnpm install --frozen-lockfile && pnpm verify`. Evidence çıktısı
zaman damgası içermez ve redaktedir; iki ardışık koşu bayt-aynı deterministik
çekirdek üretir. İmzalı release artifact'i ve provenance `wp29:signatures`
hattında kalır ve `docs/operations/public-release-checklist.md` bu hatta
bağlanır.

## Sonuçlar

- Hosted rakip, ürünü kapalı biçimde servisleştiremez; Managed Cloud
  farklılaşması korunur.
- Self-hosted kullanıcı ve katkıcı için sürtünme düşüktür; DCO dışında ek
  bürokrasi yoktur.
- AGPL'den kaçınan kurumsal kullanıcılar için tek seçenek Managed Cloud veya
  ileride tanımlanabilecek ticari lisanstır; bu bilinçli bir ticari tercihtir.
- Bağımlılık politikası permissive kaldığı için lisans gate'i mevcut ağaçta
  değişiklik gerektirmez; gate ihlalde fail eder ve bu testle kanıtlanır.
- Repository fiilen public yapılmadan önce `docs/operations/public-release-checklist.md`
  izlenmelidir; publish kararı ve "Codex" marka riski (bkz.
  `docs/policies/brand-and-endorsement-policy.md`) yönetici onayına bağlıdır.
