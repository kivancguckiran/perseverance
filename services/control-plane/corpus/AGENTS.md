# Control Plane Corpus Schema

Bu dosya `corpus/` altındaki tüm çalışmalarda önceliklidir. Corpus'un dili Türkçedir; code symbol, protocol field ve yerleşik teknik terimler English kalabilir.

## Amaç ve sahiplik

- `raw/` immutable kaynak alanıdır. Var olan bir raw dosyayı düzeltme; yeni bir revizyon olarak ekle.
- `sources/` doğruluk kaynaklarını kaydeder. Repo içi kaynaklar yerinde okunur ve Git revision ile izlenir; corpus içine kopyalanmaz.
- `wiki/` ajan tarafından yazılan türetilmiş bilgi katmanıdır. Kullanıcı okur, ajan bakımını yapar.
- `log.md` append-only'dir. Eski girdileri yeniden yazma veya sıralama.
- Wiki hiçbir zaman secret, bearer token, API key, hassas environment değeri veya gizli chain-of-thought içermez.

## Sayfa şeması

Her `wiki/*.md` dosyası şu YAML frontmatter alanlarını taşır:

```yaml
---
title: İnsan tarafından okunur başlık
kind: overview | component | concept | decision | runbook
status: current | draft | stale
updated: YYYY-MM-DD
source_ids:
  - SRC-...
tags:
  - kebab-case
---
```

Gövde sırası ihtiyaca göre değişebilir; fakat her sayfa en az bir `## Özet` başlığı, doğrulanabilir kaynak bağlantıları ve ilgili wiki sayfalarına bağlantılar içermelidir. Doğrulanmamış çıkarımları açıkça `Çıkarım:` diye işaretle.

## Source kimliği

- Repo dosyası veya dosya grubu: `SRC-REPO-NNN`
- ADR: `SRC-ADR-NNNN`
- Harici snapshot: `SRC-EXT-NNN`
- Kullanıcı notu: `SRC-NOTE-NNN`

`sources/index.md` her kimlik için title, type, location, revision/hash, status ve kısa kapsam taşır. Repo kaynağında revision `WORKTREE` olabilir; bu, uncommitted içeriğin okunduğunu görünür kılar.

## Ingest

1. `wiki/index.md`, `sources/index.md` ve son beş `log.md` girdisini oku.
2. Kaynağı kaydet. Harici içerikte URL tek başına yeterli değildir; mümkünse tarihli immutable snapshot oluştur ve hash kaydet.
3. Kaynağın ana iddialarını, sınırlarını ve mevcut sayfalarla çatışmalarını çıkar.
4. Tek bir source summary üretmekle yetinme: overview, component, concept ve decision sayfalarından etkilenenleri güncelle.
5. Yeni veya değişen her wiki sayfasını `wiki/index.md` içine bir cümlelik açıklamayla bağla.
6. `log.md` sonuna `## [YYYY-MM-DD] ingest | Başlık` biçiminde girdi ekle.
7. `pnpm corpus:lint` çalıştır.

## Query

1. Önce `wiki/index.md` üzerinden ilgili sayfaları seç.
2. Yanıtı wiki sentezinden kur, kritik noktaları manifestteki raw/repo kaynaklarında doğrula.
3. Kaynak ile wiki çelişirse kaynak kazanır; wiki'yi aynı işlemde düzelt.
4. Tekrar kullanılabilir yeni bir sentez oluştuysa uygun wiki sayfasına işle ve `## [YYYY-MM-DD] query | Soru` log girdisi ekle.

## Lint ve bakım

Periyodik bakımda şunları ara:

- Kırık Markdown bağlantıları ve manifestte olmayan `source_id` değerleri.
- Inbound bağlantısı olmayan wiki sayfaları.
- `stale` sayfalar ve daha yeni kaynakların geçersiz kıldığı iddialar.
- Birbiriyle çelişen sayfalar veya ADR kararları.
- Sayfası olmayan ama birden çok yerde geçen önemli kavramlar.
- Secret, local runtime verisi, `.runtime/`, generated output veya dependency içeriğinin yanlışlıkla corpus'a alınması.

Her bakım çalışmasını `## [YYYY-MM-DD] lint | Kapsam` biçiminde logla.
