# WP26 production topology, migration ve rollback runbook

## Deployment order

1. PostgreSQL backup/PITR ve replica lag operatör tarafından doğrulanır.
2. `0028_ha_scheduler_capacity.sql` expand migration'ı uygulanır.
3. N-1 API ile schema/readiness compatibility probe çalıştırılır; scheduler writer
   kapalıdır.
4. N API/realtime instance'ları en az iki replica olarak başlatılır. PostgreSQL,
   broker, object storage, KMS ve runtime-control probe'ları hazır olmadan traffic
   verilmez.
5. Tek scheduler cohort'u açılır, sonra ikinci instance yarışa katılır. Lease/fence,
   duplicate-start ve billing binding kontrol edilir.
6. Workspace node cohort'u açılır; cgroup v2 ve volume/egress policy gerçekleşmeden
   node `ready` kaydedilmez.
7. Eski writer'lar drain edilince N contract writer authoritative olur.

## Compatibility window

N ve N-1 reader'ları bir rollout window'u birlikte desteklenir. Migration yalnız yeni
tablolar, functions, indexes ve defaulted alanlar ekler. Queue contract v1 bilinmeyen
alanları ignore eder; bilinmeyen state işlenmez ve poison/retry'ye çevrilmez. Schema
version mismatch readiness'i kapatır.

## Rollback

1. Scheduler admission'ı kapat ve region/node'u cordon et.
2. Active lease'leri bounded deadline'a kadar drain et; expired lease'leri recovery
   outcome ile kapat. Prompt'u otomatik tekrar gönderme.
3. N writer'ı durdur; N-1 binary'yi aç ve dependency/schema compatibility probe'u
   doğrula.
4. 0028 tablolarını veya fencing counter'larını drop/truncate etme. Yeni queue item'ları
   N tekrar devreye girene kadar durable kalır.
5. Roll-forward mümkün değilse operator recovery ve WP27 DR prosedürüne geç.

## Fail-closed checks

- `eventStore=sqlite`, queue/lock `memory|cache`, local artifact/attachment/source
  filesystem production'da reddedilmelidir.
- PostgreSQL, broker, object storage, KMS veya runtime-control kaybı readiness=false ve
  new admission=503 üretmelidir.
- Cache kaybı yalnız cache miss üretir; lease/fencing PostgreSQL'den doğrulanır.
- Log ve kabul evidence'i yalnız opaque instance/region/node/runtime/workspace/lease/
  fencing/run ID ile ölçüm taşır; prompt/output/source/secret taşımaz.
