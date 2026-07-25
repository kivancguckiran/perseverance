# Provider credential yaşam döngüsü runbook'u

## Değişmezler

- Credential tenant/organization/workspace dışına taşınmaz ve pool edilmez.
- Support/UI plaintext credential okuyamaz. Log, trace, event, fixture, snapshot,
  backup ve export yalnız redakte metadata taşır.
- Subscription flag'i provider/auth-mode specific ve default-off'tur.
- Codex cloud evidence, Claude previous approval veya cloud customer-key custody
  evidence eksikse flag açılmaz.
- Gemini consumer subscription OAuth hiçbir koşulda açılmaz.

## Bağlama

1. Deployment profile, provider, auth mode ve evidence version ile capability
   kararını çalıştırın.
2. `deny` sonucundaki actionable message'ı kullanıcıya gösterin; bypass etmeyin.
3. PKCE'de state'i yalnız çağırana verin; durable kayıtta sadece digest bulunur.
   Device flow'da user code yalnız kullanıcı yüzeyinde, device code encrypted
   transaction'da bulunur.
4. Token exchange sonucunu doğrudan vault'a verin. Plaintext'i loglamayın veya
   intermediate JSON dosyasına yazmayın.
5. Cloud'da production KMS ve WP33 tenant runtime identity kanıtını doğrulayın.

## Lease ve refresh

Runtime `RuntimeDataPlaneAuthority` üzerinden tenant, workspace, runtime,
generation ve `provider-credential.lease` action scope'lu kısa ömürlü credential
alır. Vault yalnız bu doğrulamadan sonra memory-only lease üretir. Stale generation,
yanlış tenant/workspace, expired/revoked workload token veya provider profile
fail-closed reddedilir.

Refresh lock 30 saniyelik owner lease'idir. `PROVIDER_REFRESH_IN_PROGRESS` alan worker
refresh yapmaz; bounded jitter ile tekrar kuyruğa alınır. Lock süresi dolmadan ikinci
refresh başlatılmaz. Başarılı refresh credential version'ı artırır; başarısız refresh
mevcut envelope'i değiştirmez.

## Rotation, revoke, disconnect ve crypto-erasure

- Rotation: KMS current key version ile yeni envelope yazın; eski version CAS
  conflict verirse tekrar okuyun.
- Revoke: profile'ı `revoked` yapın, yeni lease'leri durdurun ve provider revoke
  endpoint'i varsa çağrının sonucunu secret içermeyen audit ile kaydedin.
- Disconnect: revoke sonrası profile envelope'ini silip `crypto-erased` yapın.
- Workspace deletion: bütün profile'lar disconnected/crypto-erased olduktan sonra
  ADR-0017 workspace KMS grant/key erasure adımını çalıştırın.
- Provider revoke endpoint'i ulaşılamıyorsa yerel revoke yine fail-closed uygulanır;
  retry işi credential plaintext'i taşımaz.

## Terms değişikliği / kill switch

1. Watch list evidence hash veya effective date değiştiğinde ilgili
   `provider:authMode` kill switch değerini `false` yapın.
2. Yeni işleri ve yeni credential lease'lerini durdurun.
3. Aktif işleri secret içermeyen güvenli terminal/checkpoint durumuna taşıyın.
4. Etkilenen tenant'lara desteklenen alternatif modu (API key veya platform credit)
   gösterin.
5. Gerekirse revoke/disconnect/crypto-erasure uygulayın.
6. Yeni provider incelemesi ve tarihli evidence olmadan switch'i geri açmayın.
7. `pnpm wp34:kill-switch` ve `pnpm wp34:leak-scan` kanıtlarını alın.

## Olay müdahalesi

Credential sızıntısı şüphesinde önce provider/auth-mode kill switch'i kapatın, sonra
etkilenen profile'ları revoke edin. Log/evidence kopyalarını çoğaltmayın. Provider
token'ını rotate/revoke edin, local envelope'i crypto-erase edin, tenant ve zaman
aralığı bazında redakte audit'i inceleyin. Başka tenant etkisi varsaymayın; FORCE RLS,
AAD ve runtime scope substitution gate sonuçlarını doğrulayın.

## Doğrulama

`pnpm wp34:test`, `wp34:oauth`, `wp34:vault`, `wp34:kill-switch`,
`wp34:leak-scan`, `wp34:provider-smoke` ve son olarak `wp34:accept` çalıştırılır.
Provider credential ortamı yoksa smoke `not-run` ve non-zero kalır; bu sonuç kabul
edilmiş sayılmaz. Genel repository kontrolleri `pnpm verify` ve
`pnpm release:public-preflight` ile tamamlanır.

Durable gate'ler önce `WP34_DATABASE_URL` değerini kullanır ve evidence'ta
`source: operator-database` yazar. Değer yoksa geçici PostgreSQL 16.13 Docker
container'ına düşer (`source: docker-postgres`). İkisi de yoksa gate
`docker-daemon` ve `WP34_DATABASE_URL` eksiklerini `not-run` olarak bildirip exit 1
üretir. Operatör URL'si boş, disposable bir veritabanını göstermelidir; ilk gate
şemayı oluşturup marker koyar, aynı `wp34:accept` zincirindeki sonraki gate'ler
yalnız bu marker varsa gate'e ait tenant fixture kayıtlarını temizleyip şemayı
yeniden kullanır. Başka bir mevcut şema düşürülmez.
