# WP18 tenant-aware object ve cache tasarımı

- Artifact ve attachment path/object key server tarafından
  `organization/workspace/session/resource` bileşenlerinden üretilir. Client tam key
  veremez.
- Metadata organization/workspace/session scope'u ile object prefix'i eşleşmeden
  resolve edilmez. Traversal, symlink, `/proc` ve `/sys` escape mevcut storage
  adapter'larında fail-closed kalır.
- Artifact grant random 256-bit opaque token, 60 saniye TTL, tek artifact, tek full
  download operation ve consume-once semantiğine sahiptir. Replay, path değiştirme ve
  grant dışı Range `404/416` üretir. Public bucket/object yoktur.
- Encryption context contract'ı PostgreSQL metadata'sında organization/workspace için
  hazırdır; KMS/DEK/KEK ve application encryption WP19 kapsamındadır.
- React Query anahtarları ve offline history/conversation snapshot'ları
  `subject:organization:workspace` namespace'i taşır. Principal/org/workspace değişince
  eski namespace okunmaz veya mutate edilmez.
- Provider model catalog'unun global model metadata'sı tenant config/readiness/auth
  sonucundan ayrılır. Readiness ve policy cache'i tenant namespace'idir.
- Service Worker authorization, `/v1`, attachment, artifact ve private/no-store
  response'ları cache'lemez. JWT ve secret hiçbir cache'e yazılmaz.
