# WP18 identity ve authorization troubleshooting

## Güvenli hata sınıfları

- `401 AUTH_REQUIRED`: Bearer token yok veya authentication kurulamadı.
- `403 TOKEN_*` / `OIDC_*`: issuer, audience, signature, lifetime, algorithm, JWKS
  veya discovery doğrulaması başarısız.
- `403 ACCESS_DENIED`: principal membership/action/resource policy deny.
- `403 AUTHZ_ROUTE_UNCOVERED`: yeni public route action kataloğuna eklenmemiş.
- `404 *_NOT_FOUND`: principal istenen organization/workspace için yetkili, fakat
  opaque resource o scope'ta bulunmuyor.
- WebSocket `4401`: token expired/re-auth gerekir.
- WebSocket `4403`: membership revoke veya policy deny.

Raw JWT, authorization header, JWKS response gövdesi ve hassas claim loglanmaz. Tanıda
yalnız issuer, opaque subject hash'i, action, outcome, reason code ve correlation ID
kullanılır.

Local geliştirme yalnız `PERSISTENT_CODEX_LOCAL_ALPHA=1` ile explicit dev-auth açar.
Bu modda scope header'ı test principal üretmek için kullanılabilir; production'da
`OIDC_ISSUER` ve `OIDC_AUDIENCE` zorunludur.

Key rotation sırasında bilinmeyen `kid` bir kez JWKS refresh tetikler. Refresh sonrası
key hâlâ yoksa veya network/JWKS arızalıysa fail-open yapılmaz.
