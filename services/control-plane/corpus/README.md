# Workspace Corpus

Bu dizin, workspace içindeki kaynakların Karpathy'nin “LLM Wiki” yaklaşımıyla tutulan kalıcı bilgi katmanıdır. Amaç her soruda ham dosyaları baştan keşfetmek yerine, kaynaklara bağlı ve zaman içinde gelişen bir wiki oluşturmaktır.

Bu corpus, ürün spesifikasyonundaki gelecekteki multi-tenant retrieval servisi değildir. Bugün repo içinde çalışan, Git ile sürümlenen bir bilgi tabanıdır; mühendislik kaynaklarının yanında kullanıcının sağladığı araştırma ve düşünce metinlerini de barındırabilir.

## Katmanlar

- `raw/`: Repo dışından alınan immutable kaynak snapshot'ları ve alım kuyruğu.
- `sources/`: Repo içi ve dışı doğruluk kaynaklarının manifestleri.
- `wiki/`: Ajanın oluşturduğu ve güncel tuttuğu sentez, kavram ve bileşen sayfaları.
- `AGENTS.md`: Ingest, query ve lint iş akışlarının schema'sı.
- `log.md`: Append-only corpus işlem günlüğü.

## Hızlı kullanım

1. Bir soruya başlamadan önce [`wiki/index.md`](wiki/index.md) dosyasını oku.
2. Yeni bir kaynak için `sources/index.md` manifestini güncelle; dış kaynaksa önce `raw/` altına snapshot al.
3. İlgili wiki sayfalarını, bağlantıları ve çelişki notlarını aynı değişiklikte güncelle.
4. İşlemi `log.md` sonuna ekle.
5. `pnpm corpus:lint` çalıştır.

Wiki, kanıtın yerine geçmez. Önemli iddialar `source_id` ve mümkün olduğunda dosya/satır bağlantısıyla doğruluk kaynağına geri dönmelidir.
