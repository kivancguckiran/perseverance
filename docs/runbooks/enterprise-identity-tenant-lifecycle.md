# Enterprise identity ve tenant lifecycle runbook

## Onboarding

1. Tenant ve organization scope'unu, primary/allowed region'ları ve retention policy
   version/effective date'ini oluşturun.
2. Domain challenge'ı tenant admin'e gösterin; raw token'ı loglamayın. Süre ve
   single-use consume doğrulanmadan domain'i verified yapmayın.
3. OIDC/SAML metadata'sını issuer/entity, audience, callback/ACS, key/certificate ve
   clock-skew ile kaydedin. Rotation overlap'ini doğruladıktan sonra yeni version'ı
   açın.
4. Enforced SSO/MFA'yı önce test cohort'unda doğrulayın. Emergency hesabın ayrı
   credential, phishing-resistant MFA, notification ve immutable audit koşullarını
   test edin.
5. SCIM bearer secret'ını secret store'da verin; `/Users` ve `/Groups` contract,
   duplicate/out-of-order ve deactivate tatbikatını çalıştırın. Bilinmeyen group-role
   mapping deny kalmalıdır.

## Retention, hold ve export

- Policy değişikliğinde önceki version'ı ve effective date'i koruyun. Worker bounded
  checkpoint'ini ve audit-chain head'ini kaydedin.
- Legal hold yalnız compliance/legal rolü, reason, expiry ve expected version ile
  açılır/kapanır. Hold kalan class ve expiry görünmeden delete tamamlandı denmez.
- Export/DSAR için ayrı privilege, approval ve re-auth gerekir. Manifest scope,
  watermark, checksum, length ve key version doğrulanmadan download açılmaz. TTL
  bitince archive ve download capability silinir.

## Offboarding

Delete job'ı başladıktan sonra admission cordon'u gözleyin. Sırasıyla session/token,
lease/turn, cache/index, object/metadata ve backup katmanlarını doğrulayın. Hold veya
statutory retention varsa receipt kalan class/reason/expiry taşır. Son reaper koşusu
KMS key-version destroy ve eski ciphertext unwrap/decrypt reddini kanıtlamadan final
receipt üretmez.

## Incident ve rollback

- Issuer/audience/signature/replay hatasında SSO bypass açmayın; ilgili federation
  version'ını disable edip emergency prosedürünü kullanın.
- SCIM out-of-order olayında provider version'ı geri almayın. Deprovision başarısızsa
  tenant/user admission cordon'u açık kalsın ve worker checkpoint'ten retry etsin.
- Region dependency/capacity yoksa silent fallback yapmayın. İzinli transfer için
  source/destination, reason, actor, class, bytes ve approval audit kaydı zorunludur.
- Acceptance: `WP28_CODEX_BIN=<0.144.2> pnpm wp28:accept`; ardından `pnpm verify`.
  External enterprise IdP/KMS/managed-region testleri credential yoksa `not-run`
  olarak kalır, fixture ile passed gösterilmez.
