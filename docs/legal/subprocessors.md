# Managed Cloud subprocessors

Public beta öncesi güncel subprocessor adı, işlevi, işlenen veri sınıfı, bölgesi,
bağlayıcı terms/DPA bağlantısı ve değişiklik bildirim tarihi burada yayımlanacaktır.

| Subprocessor     | İşlev                       | Veri sınıfı                          | Bölge                         | Durum                         |
| ---------------- | --------------------------- | ------------------------------------ | ----------------------------- | ----------------------------- |
| Hosting provider | Compute, storage, network   | Tenant runtime metadata/content      | Seçilen tenant region         | Beta öncesi kesinleştirilecek |
| Email provider   | Transactional notifications | Email address, notification metadata | Beta öncesi kesinleştirilecek | Beta öncesi kesinleştirilecek |
| Push provider    | Web push delivery           | Push endpoint ve opaque payload      | Provider dependent            | WP23 contract'ına bağlı       |

Model provider'ları tenant'ın seçtiği ayrı processor/controller ilişkisine tabi
olabilir; provider auth capability ve güncel terms kararı WP34 kaynağından gelir.
Liste değişikliği hukuk/privacy onayı ve kullanıcı bildirim sürecinden geçer.
