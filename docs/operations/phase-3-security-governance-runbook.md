# Faz 3 security governance runbook

Bu runbook WP18–WP20 güvenlik sınırını işletir. Tenant içeriğini ticket, log, audit,
alarm veya notification payload'ına kopyalamayın. Her işlem organization, workspace,
session/object/action ve correlation ID ile yürütülür.

## Support access

1. Tenant kullanıcısı ilgili sohbetin **Support erişimi** yüzeyini açar; yalnız gereken
   action'ları, support principal'ı, süreyi ve gerekçeyi seçer.
2. Güçlü MFA doğrulanır. `content.view` için yetkili support approval; download/decrypt
   için farklı iki approver gerekir. Decrypt onay zinciri `kms_operator` içermelidir.
3. Support yalnız active grant'in exact scope'unda kısa JIT lease alır. Yanlış session,
   object veya action denemesi incident sinyali olarak incelenir.
4. İş bittiğinde kullanıcı veya security approver grant'i erken iptal eder. Generation
   artışı, lease/token/signed URL/cache ve devam eden erişim oturumlarını kesmelidir.

## Break-glass

1. On-call operator geçerli `INC-...` incident ID, dar session/object/action ve en çok
   15 dakika TTL ile ayrı break-glass request açar.
2. Güçlü MFA ve requester'dan farklı iki `security_approver`/`kms_operator` kararı
   olmadan aktivasyon yapılamaz.
3. Aktivasyon transaction'ında durable `break_glass_alarm` outbox kaydı bulunmalıdır.
   Alarm delivery başarısızsa access sonucu değiştirilmez; exponential backoff ve DLQ
   alarmı ile retry edilir.
4. Erken revoke veya TTL bitişi generation'ı artırır. `break_glass.ended` audit'i ve
   sonradan tenant `tenant_notification` outbox kaydı zorunludur.

## Tenant incident ve kullanıcı bildirimi

- Correlation/incident/grant/break-glass ID'lerini koruyun; tenant içeriğini incident
  sistemine taşımayın.
- Notification erişimin nedeni, kapsamı, başlangıç/bitiş zamanı ve sonucu belirtir;
  secret, token, raw payload veya decrypted içerik içermez.
- Delivery ve access decision ayrı audit kayıtlarıdır. Teslim edilemeyen notification
  outbox'ta pending kalır ve sahipli alarm üretir.

## Compromised key ve emergency rotation

1. Etkilenen workspace grant, lease ve KMS grant'lerini revoke edin; generation'ları
   artırın ve yeni decrypt'i durdurun.
2. KMS key version rotation çalıştırın: `pnpm wp19:key-rotation`.
3. Re-encryption/backfill tamamlanana kadar eski key yalnız read-old/write-new
   politikasıyla tutulur. Şüpheli key revoke edilir; gerekiyorsa crypto-erasure:
   `pnpm wp19:crypto-erasure`.
4. Backup/restore context'ini `pnpm wp19:backup-restore` ile doğrulayın ve tenant'a
   incident prosedürüne göre bildirim gönderin.

## Grant, token ve lease iptali

- Grant/break-glass kaydını expected version ile terminal duruma taşıyın.
- Aynı transaction'da revocation epoch/generation artırılmalı; aktif JIT lease'ler
  revoked olmalıdır. Signed URL ve cache doğrulaması her kullanımda generation okur.
- Revoke sonrası eski aracı tekrar kullanmayı deneyen adversarial kontrol
  `LEASE_REVOKED_OR_EXPIRED` ile reddedilmelidir.

## Audit integrity

- Local domain zinciri WP20 testinde `verifyAuditChain()` ile doğrulanır.
- PostgreSQL kanıtı: `pnpm wp20:postgres`. Bu smoke application-role update/delete
  reddini, forced RLS'yi, cross-tenant erişimi ve concurrent chain insert'i doğrular.
- Zincir hatasında audit tablosunu düzeltmeyin. Yazmayı fail-closed durdurun, incident
  açın, DB/WAL/backup kanıtlarını salt okunur koruyun ve bağımsız inceleme başlatın.

## Kabulün tekrarlanması

- Local adversarial kabul: `pnpm phase3:accept`.
- Production kabulü yalnız gerçek altyapıyla:

  ```sh
  PHASE3_PRODUCTION_ACCEPTANCE=1 \
  WP19_KATA_RUNTIME_CLASS=<runtime-class> \
  WP19_ENCRYPTED_STORAGE_CLASS=<storage-class> \
  WP19_AWS_KMS_KEY_ID=<temporary-customer-managed-key> \
  pnpm phase3:accept
  ```

Local process, mock veya local-memory KMS sonucu production isolation diye raporlanmaz.

## Cleanup

- Smoke container, namespace/pod/PVC/PV/StorageClass, tünel, compute node, encrypted
  volume, security group, IAM role/profile ve geçici kubeconfig'i envanterle silin.
- Geçici customer-managed KMS key'i kurum politikasındaki bekleme süresiyle deletion'a
  alın. Key ARN veya ciphertext'i rapora yazmayın; yalnız güvenli hash/sonuç kullanın.
- `docker ps -a --filter name=persistent-codex-wp`, geçici cloud resource envanteri ve
  `git status --short` boş/expected olana kadar cleanup tamamlandı sayılmaz.
