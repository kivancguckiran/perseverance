# Tek kiracılı alfa runbook

Bu runbook yalnız lokal, tek kullanıcı/tek tenant Faz 1 alfa kurulumu içindir. Production
deployment, çok kiracılık, KMS/Vault ve uzaktan erişim kapsam dışıdır.

## Desteklenen yaşam döngüsü

Önkoşullar: Node.js 24 veya daha yeni, pnpm 9.15.3, Git ve pinli Codex CLI 0.144.2.

```bash
pnpm install --frozen-lockfile
pnpm generate:codex-protocol
pnpm alpha:dev
```

Uygulama `http://127.0.0.1:3000`, control plane `http://127.0.0.1:3100`
adresindedir. `pnpm alpha:dev` foreground supervisor'dır. Stop için aynı terminalde
`Ctrl-C` kullanılır; child süreçlere signal iletilir. Restart, stop tamamlandıktan sonra
aynı `pnpm alpha:dev` komutudur. Başlatmadan sonra `/healthz` liveness ve `/readyz`
dependency/auth readiness ayrı kontrol edilir.

Protocol generation iki kez aynı sonucu vermelidir:

```bash
pnpm generate:codex-protocol
pnpm generate:codex-protocol
git diff -- packages/codex-protocol-generated
```

Generated dosyalar elle düzenlenmez. Drift varsa Codex sürümü, generator metadata'sı
ve adapter sözleşmeleri birlikte incelenir.

## Kalıcı yollar

Varsayılan server-owned state repository köküne göre şöyledir:

| Veri                | Varsayılan                                                       | Override                    |
| ------------------- | ---------------------------------------------------------------- | --------------------------- |
| SQLite              | `.runtime/alpha/events.sqlite`                                   | `EVENT_DATABASE_PATH`       |
| Workspace           | repository kökü                                                  | `WORKSPACE_CWD`             |
| Codex homes         | `.runtime/alpha/codex-homes`                                     | `CODEX_HOME_ROOT`           |
| Artifacts           | `.runtime/alpha/artifacts`                                       | `ARTIFACT_ROOT`             |
| Auth/config kaynağı | `CODEX_PROVISIONING_SOURCE`, sonra lokal `CODEX_HOME`/`~/.codex` | `CODEX_PROVISIONING_SOURCE` |

Codex home içinde yalnız allowlist'li `auth.json` ve `config.toml` read-only symlink
edilir. Session/history/log/plugin içeriği kişisel Codex home'dan kopyalanmaz.

## Upgrade ve migration provası

1. `pnpm alpha:dev` sürecini durdur.
2. Aşağıdaki backup prosedürünü uygula.
3. `pnpm install --frozen-lockfile` ve iki kez protocol generation çalıştır.
4. `pnpm alpha:lifecycle` ile v5→v6 migration, start/stop/restart ve restore provasını çalıştır.
5. `pnpm verify` ve `pnpm alpha:accept` geçir.
6. Uygulamayı başlatıp `/readyz`, yakın session, Git snapshot ve audit panelini kontrol et.

Migration başarısızsa aynı DB üzerinde tekrar tekrar yazma yapılmaz. Süreç durdurulur,
bozuk aday saklanır ve doğrulanmış backup yeni bir dosyaya restore edilir.

## SQLite backup ve restore

Bu alfa online dosya kopyasını desteklemez. Güvenli prosedür:

1. Foreground alfa sürecini tamamen durdur ve 3000/3100 portlarında child kalmadığını doğrula.
2. SQLite CLI ile `PRAGMA wal_checkpoint(TRUNCATE);` ve `PRAGMA integrity_check;` çalıştır; sonuç `ok` olmalıdır.
3. DB dosyasını yeni, private bir backup dosyasına kopyala. `-wal` veya `-shm` dosyasını tek başına kopyalama.
4. Backup üzerinde yeniden `PRAGMA integrity_check;` çalıştır.
5. Restore için mevcut DB'nin üzerine yazma. Backup'ı yeni bir DB path'ine kopyala,
   `EVENT_DATABASE_PATH` ile bu adayı aç ve `/readyz` ile session/audit sayılarını doğrula.
6. Doğrulama başarısızsa adayı kapat ve önceki DB'ye dön.

`pnpm alpha:lifecycle` aynı checkpoint → copy → integrity → yeni path'te restore akışını
geçici ve içeriksiz bir DB üzerinde otomatik prova eder.

## Cleanup ve arıza giderme

- Artifact cleanup: alfa kapalıyken session/audit ihtiyacını doğrula. Yalnız server-owned
  artifact root altındaki yaşlı orphan `.tmp` dosyaları storage cleanup mekanizmasıyla
  silinir; finalized artifact dosyaları DB metadata'sından bağımsız elle silinmez.
- Auth recovery: `/readyz` `setup_required` ise provisioning source üzerinde `codex login`
  çalıştır, sonra readiness retry ve aynı session resume kullan. Credential içeriğini loga
  veya destek paketine kopyalama.
- Disk pressure: önce `/readyz` disk/artifact/database check'ini oku. Alfa sürecini
  durdur; orphan temp ve artık gerekmeyen tamamen geçici acceptance state'ini temizle.
  DB/WAL veya finalized artifact'i rastgele silme.
- Crash-loop: süreci tekrar tekrar başlatma. Pinli `codex --version`, canonical workspace,
  provisioning ve yazılabilir runtime root kontrollerini düzelt; sonra tek restart yap.
- Stale runtime: UI read-only timeline'ı korurken readiness retry, ardından aynı session
  resume çalıştır. Yeni session açarak kaybı maskeleme.
- Orphan process/port: `lsof -nP -iTCP:3000 -iTCP:3100 -sTCP:LISTEN` ile doğrula. Yalnız
  bu alfa komutuna ait PID'leri graceful signal ile durdur; başka kullanıcı süreçlerini öldürme.
- Dirty workspace: otomatik clean/reset yapılmaz. Git before/after snapshot ile mevcut
  değişiklikler korunur; cleanup workspace dosyalarına dokunmaz.

## Bilinen alfa sınırlamaları

- Tek kullanıcı, tek tenant, server-configured tek lokal workspace ve tek aktif turn.
- SQLite tek-node'dur; uzun ömürlü ikinci writer desteklenmez.
- Lokal process sınırı production sandbox veya tenant izolasyonu değildir.
- Auth mevcut lokal Codex login'ine dayanır; BYOK, browser login ve secret manager yoktur.
- Backup offline'dır; production snapshot/DR ve point-in-time recovery yoktur.
- Artifact storage lokal filesystem'dir; object storage, replication ve otomatik retention yoktur.
- Metrics process-local bounded JSON aggregate'dir; harici collector/alerting yoktur.
- Git yüzeyi salt-okunurdur; commit/push/checkout/restore yoktur.
- Faz 2 multi-tenant güvenlik, scheduler, billing, egress policy ve production deployment başlatılmamıştır.
