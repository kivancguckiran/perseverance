export function resolveBillingBootstrap(env: NodeJS.ProcessEnv) {
  const localAlpha = env.PERSISTENT_CODEX_LOCAL_ALPHA === '1'
  const databaseUrl = env.BILLING_DATABASE_URL
  const provider = env.PERSISTENT_BILLING_PROVIDER
  if (!databaseUrl)
    throw new Error(
      localAlpha
        ? 'Local alpha billing requires BILLING_DATABASE_URL and an applied PostgreSQL billing schema'
        : 'Production requires BILLING_DATABASE_URL for durable commercial policy state',
    )
  if (localAlpha && provider !== 'emulator')
    throw new Error(
      'Local alpha requires explicit PERSISTENT_BILLING_PROVIDER=emulator; the emulator is never selected implicitly',
    )
  if (!localAlpha) {
    if (provider !== 'production')
      throw new Error(
        'Production requires PERSISTENT_BILLING_PROVIDER=production',
      )
    throw new Error(
      'Production billing startup requires an injected production provider and secret adapter; the development emulator is forbidden',
    )
  }
  return { localAlpha, databaseUrl, provider: 'emulator' as const }
}
