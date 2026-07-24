import { resolveBootProfile } from './profile-composition'

// WP33: deployment profili boot'ta çözülür; bilinmeyen profil ve cloud
// profilindeki development fallback'leri fail-closed reddedilir (ADR-0033).
const { profile } = resolveBootProfile(process.env)

if (profile === 'local') {
  await import('./main')
} else {
  const { buildProductionControlPlaneFromEnv } =
    await import('./production-server')
  const app = await buildProductionControlPlaneFromEnv(process.env)
  const port = Number.parseInt(process.env.PORT ?? '3100', 10)
  const host = process.env.HOST ?? '0.0.0.0'
  await app.listen({ host, port })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.close()
  }
  process.once('SIGTERM', () => void close())
  process.once('SIGINT', () => void close())
}
