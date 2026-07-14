# Alfa auth ve readiness sorun giderme

## Başlatma

Repository kökünde `pnpm alpha:dev` çalıştırın. Codex CLI sürümü tam olarak `0.144.2`
olmalıdır. Lokal akış mevcut Codex CLI login'ini credential kopyalamadan kullanır.
Credential içeriğini environment'a, browser'a veya uygulama API'sine yapıştırmayın.

## Readiness durumları

- `checking`: Generated `account/read` yanıtı bekleniyor.
- `ready`: Preflight ve Codex account kontrolü geçti; session/turn gönderilebilir.
- `setup_required`: Login yok. Ayrı terminalde `codex login` çalıştırıp arayüzde
  “Readiness yeniden dene”yi seçin.
- `degraded`: Binary sürümü, unsafe path, permission, provisioning source veya runtime
  kontrolü bozuk. Typed check kodunu düzeltip yeniden deneyin.

`/healthz` process liveness'ını, `/readyz` dependency ve auth readiness'ini gösterir.
Response'lar token, account payload, credential içeriği veya kullanıcı home path'i
içermez.

## 401 recovery

Mid-session HTTP 401 aynı session/thread binding'ini silmez. Timeline'da tekrar eden
reconnect kartları yerine tek `AUTH_REQUIRED` durumu görünür. `codex login` sonrasında
readiness retry yapın ve aynı session için resume kullanın. Read-only timeline auth
düzeltilirken kullanılabilir. Auth dışı network reconnect olayları coalesce edilmez.

## Preflight kodları

- `CODEX_VERSION_MISMATCH`: pinli Codex CLI kullanılmıyor.
- `PROVISIONING_SOURCE_MISSING`: explicit source bulunamadı.
- `AUTH_CONFIG_MISSING`: source içinde allowlist dosyası yok.
- `PROVISIONING_SYMLINK_ESCAPE` / `PROVISIONING_TARGET_NOT_FILE`: source unsafe.
- `PATH_SYMLINK_COMPONENT` / `UNSAFE_RUNTIME_PATH`: runtime path'i güvenli değil.
- `PATH_NOT_WRITABLE`: workspace veya persistent runtime path'i yazılabilir değil.

Production servis başlangıcında `CODEX_PROVISIONING_SOURCE` açıkça verilmelidir;
`~/.codex` örtülü varsayımı yalnız `pnpm alpha:dev` akışına aittir.
