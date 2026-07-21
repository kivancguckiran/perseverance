# WP29 güvenli release ve provider upgrade runbook

## Önkoşullar

- Release source exact ve temiz commit olmalıdır. Dirty/untracked source yalnız ayrı
  `acceptance-fixture` worktree'sinde test edilebilir ve production admission alamaz.
- `pnpm@9.15.3`, lockfile ve Codex `0.144.2` binary exact pinleri doğrulanmalıdır.
- Production keyless identity, registry ve provider credential yoksa ilgili gate
  `not-run` kalır; fixture sonucu external canary olarak yeniden etiketlenmez.

## Sıra

1. `pnpm wp29:reproducible-build` ile iki izole build digest eşitliğini doğrula.
2. `pnpm wp29:sbom`, `pnpm wp29:signatures` ve `pnpm wp29:security-scans` çalıştır.
3. `pnpm wp29:migrations` ile N/N-1 ve rollback checksum rehearsal yap.
4. `WP29_CODEX_BIN=<0.144.2> pnpm wp29:provider-canary` çalıştır.
5. `pnpm wp29:rollout` ile internal/canary/limited geçişini; broken fixture ile
   halt/rollback'i doğrula.
6. `pnpm wp29:compliance` evidence mapping ve signed bundle üretimini doğrula.
7. Bütün gate'leri yeniden doğrulayan `WP29_CODEX_BIN=<0.144.2> pnpm wp29:accept`
   çalıştır. `accepted:true` yalnız checksum, signature, content scan ve cleanup
   kontrollerinden sonra üretilebilir.

## Acil durdurma ve rollback

Provider/runtime-version kill switch'i aç, yeni admission'ı kapat ve canary cohort'u
drain et. Rollback hedefi yalnız önceki admission-verifier'dan geçmiş imzalı digest
olabilir. PostgreSQL migration tablolarını drop etme; conversation, event high-water,
approval, audit, billing, corpus, SCIM ve lifecycle count/checksum değerlerini rollback
öncesi/sonrası karşılaştır. Stale approval veya promoter version'ı ile geçiş deneme.

## Cleanup

`persistent.wp29=true` label'lı container/volume, local registry object, ephemeral
private key, temporary Codex home ve child process kalmadığını kontrol et. Private key
ve temporary credential silinmeden evidence bundle kabul edilmez.
