# ADR-0009: Lokal alfa auth bootstrap ve readiness

- Durum: Kabul adayı
- Tarih: 14 Temmuz 2026

## Bağlam

Codex CLI login'i persistent workspace home'larına güvenli aktarılmadığında turn
başlangıcı HTTP 401 ve tekrar eden reconnect olaylarıyla başarısız oluyordu. Liveness
bu arızayı açıklamıyor; credential kopyalamak ise güvenlik sınırını ihlal ediyor.

## Karar

Tek desteklenen lokal başlangıç `pnpm alpha:dev` olur. Explicit
`CODEX_PROVISIONING_SOURCE` önceliklidir; yalnız lokal alfa akışı sırasıyla `CODEX_HOME`
ve `~/.codex` varsayılanını çözebilir. Production başlangıcı host credential'ına
örtülü erişmez. Provisioning yalnız canonical source içindeki `auth.json` ve
`config.toml` dosyalarını read-only symlink eder; task/session/history/log/plugin
state'i bağlanmaz ve credential içeriği okunmaz.

Preflight Codex `0.144.2`, workspace, SQLite parent, artifact root, Codex home root ve
provisioning path bileşenlerini typed sonuçlarla denetler. Unsafe veya yazılamayan
altyapı `degraded`; generated protokoldeki `account/read` ile doğrulanan eksik login
`setup_required`; başarılı durum `ready` olur. `/healthz` liveness olarak kalır,
`/readyz` redakte readiness verir. Ready olmayan session ve turn upstream'e gönderilmez.

`responseStreamDisconnected.httpStatusCode=401` veya resmi `unauthorized` Codex error
bilgisi session'ı binding'i silmeden `RECOVERY_AUTH_REQUIRED` durumuna geçirir. İlk
olay kullanıcıya güvenli ve actionable tek auth recovery olayı olarak yazılır; aynı
arıza içindeki sonraki retry transport envelope'ları redakte raw-only kanıt olarak
kalır. Auth dışı reconnect olayları normal timeline akışını korur. Login sonrası
readiness retry ve aynı-session resume uygulanır.

## Sonuçlar

Lokal kullanıcı API key girmeden mevcut Codex login'iyle çalışabilir. Login expiry
timeline'ı doldurmaz ve konuşma binding'i kaybolmaz. Production credential dağıtımı,
BYOK, browser login ve secret manager bu kararın dışındadır.
