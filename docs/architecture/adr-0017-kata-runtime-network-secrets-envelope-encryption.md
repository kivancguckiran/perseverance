# ADR-0017: Kata runtime, egress broker, secret lease ve envelope encryption

- Durum: Kabul önerisi
- Tarih: 16 Temmuz 2026
- Kapsam: Faz 3 WP19

## Bağlam

WP18 control plane kimliği, merkezi authorization ve PostgreSQL forced RLS sınırını
kurdu. Bunlar, workspace içinde çalışan zararlı kodun host filesystem'ine, başka
workspace runtime'ına, metadata servislerine veya plaintext secret ve tenant
ciphertext'lerine erişmesini tek başına engellemez. Lokal process adapter'ı geliştirme
için değerlidir fakat production tenant izolasyonu değildir.

Server-side ajan çalışırken seçili prompt, çıktı ve dosyaları geçici olarak plaintext
işlemek zorundadır. Bu nedenle WP19 confidential-computing veya client-side E2E
şifreleme iddiasında bulunmaz; güçlü runtime isolation, kısa ömürlü workload secret
lease ve application-level authenticated at-rest encryption sağlar.

## Karar

- Version 1 `WorkspaceRuntimeDriver` production backend'i Kubernetes
  `RuntimeClass` üzerinden Kata Containers (`kata-qemu`) olur. Her workspace ayrı
  micro-VM pod, service account ve encrypted CSI PVC kullanır.
- Pod spec `hostPath`, privileged, host network/PID/IPC ve privilege escalation
  kullanmaz; root filesystem read-only, bütün Linux capability'leri drop ve
  `RuntimeDefault` seccomp olur. Control plane workspace volume'ünü mount etmez.
- Lokal process driver yalnız `development_only` isolation level bildirir. Production
  config Kata ve encrypted volume kanıtı olmadan ready olmaz.
- Egress runtime namespace'inde default-deny'dır. Tek çıkış DNS-aware egress broker'dır.
  Broker policy veya tenant/organization/workspace/runtime scoped, süreli ve
  idempotent grant ister. DNS sonucu policy kararında ve connection anında yeniden
  çözülür; private, loopback, link-local, multicast, metadata ve değişen/rebinding
  adresleri reddedilir. Karar audit'i yalnız scope, hedef host/port, outcome ve reason
  taşır; payload veya secret taşımaz.
- Secret provider workload identity doğrular. Workspace Agent en çok 15 dakikalık
  lease alır; plaintext yalnız runtime içindeki memory-backed `/run/secrets` altında
  `0600` dosyada bulunur. Revoke, expiry, process exit ve runtime cleanup dosyayı
  siler. Secret argv, kalıcı environment, event, log, trace, fixture veya snapshot'a
  yazılmaz. Memory dev provider production değildir.
- Production KMS provider AWS KMS'tir. Her kayıt için rastgele 256-bit DEK üretilir;
  DEK tenant/organization/workspace encryption context ile KMS'te wrap edilir ve
  plaintext DEK kalıcı tutulmaz. Payload `AES-256-GCM`, artifact/attachment/backup ise
  bounded 64 KiB chunk başına ayrı nonce/tag ile `AES-256-GCM-CHUNKED` kullanır.
- AAD; format version, tenant, organization, workspace, record type ve record ID'yi
  bağlar. Yanlış context, key/provider substitution, modified ciphertext/tag ve eksik
  veya revoked key typed hata ile fail-closed olur.
- Rotation yeni yazılarda güncel KMS key version kullanır; eski ciphertext yalnız
  ilgili eski key version erişilebilirken okunur. Re-encryption idempotent backfill
  job'ı plaintext'i loglamadan yeni envelope yazar.
- Crypto-erasure workspace KMS grant/key material erişimini iptal eder ve immutable
  audit üretir. Encrypted backup yalnız aynı tenant/organization/workspace context'ine
  restore edilir; başka tenant veya workspace'e restore/decrypt reddedilir.

## Tehdit modeli ve kontroller

| Tehdit                          | Kontrol                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| Host/kernel escape              | Kata micro-VM, no privileged/host namespace/hostPath              |
| Traversal/symlink/mount escape  | Canonical path, component lstat, device boundary, proc/sys deny   |
| Metadata/private tenant SSRF    | Default-deny broker, IP class deny, connect-time DNS revalidation |
| Secret exfiltration/kalıntı     | Workload identity, short lease, tmpfs file, revoke/exit cleanup   |
| Cross-tenant ciphertext         | KMS encryption context + application AAD                          |
| Ciphertext/tag/key substitution | AES-GCM authentication ve key/provider/version binding            |
| Büyük artifact memory baskısı   | Versioned bounded chunk encryption                                |
| Backup tenant karışması         | Source/destination context equality ve authenticated backup AAD   |

## Sonuçlar

Kata RuntimeClass, encrypted CSI driver ve AWS KMS hesabı bulunmayan geliştirme
makinesi gerçek production smoke kanıtı üretemez. Bu durumda test atlanmış sayılmaz;
script non-zero sonuç ve eksik prerequisite bildirir. Normal Docker veya local process
smoke'u production acceptance yerine geçmez. WP20 support grant ve break-glass
yetkilerini eklemeden WP19 kendi kendine kabul edilmiş sayılmaz.
