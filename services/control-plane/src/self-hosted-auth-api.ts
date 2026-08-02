//  self-hosted kayıt/giriş/recovery HTTP API'si (ADR-0037).
// Bu uçlar OIDC bearer doğrulamasından muaftır (pre-auth); production-server
// auth hook'u SELF_HOSTED_AUTH_PUBLIC_PATHS listesini muaf tutar. Yanıtlar
// parola/recovery key/anahtar içermez; recovery key yalnız kayıt ve recovery
// yanıtlarında BİR KEZ döner ve hiçbir yerde loglanmaz.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  SelfHostedAuthError,
  type SelfHostedAuthService,
} from './self-hosted-auth'

export const SELF_HOSTED_AUTH_PUBLIC_PATHS = [
  '/v1/auth/register',
  '/v1/auth/login',
  '/v1/auth/refresh',
  '/v1/auth/recover',
  '/v1/auth/logout',
] as const

const credentialsSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(8).max(1024),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(8).max(2048),
})

const recoverSchema = z.object({
  username: z.string().trim().min(3).max(32),
  recoveryKey: z.string().trim().min(8).max(128),
  newPassword: z.string().min(8).max(1024),
})

export function registerSelfHostedAuthRoutes(
  app: FastifyInstance,
  options: { service: SelfHostedAuthService },
): void {
  const handleError = (
    error: unknown,
    reply: { code(status: number): { send(body: unknown): unknown } },
  ) => {
    if (error instanceof SelfHostedAuthError)
      return reply.code(error.statusCode).send({ code: error.message })
    if (error instanceof z.ZodError)
      return reply.code(400).send({ code: 'INVALID_AUTH_REQUEST' })
    throw error
  }

  app.post('/v1/auth/register', async (request, reply) => {
    try {
      const body = credentialsSchema.parse(request.body)
      const result = await options.service.register(body)
      return reply.code(201).send(result)
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.post('/v1/auth/login', async (request, reply) => {
    try {
      const body = credentialsSchema.parse(request.body)
      return reply.code(200).send(await options.service.login(body))
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.post('/v1/auth/refresh', async (request, reply) => {
    try {
      const body = refreshSchema.parse(request.body)
      return reply.code(200).send(await options.service.refresh(body))
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.post('/v1/auth/recover', async (request, reply) => {
    try {
      const body = recoverSchema.parse(request.body)
      return reply.code(200).send(await options.service.recover(body))
    } catch (error) {
      return handleError(error, reply)
    }
  })

  app.post('/v1/auth/logout', async (request, reply) => {
    try {
      const body = refreshSchema.partial().parse(request.body ?? {})
      await options.service.logout(
        body.refreshToken ? { refreshToken: body.refreshToken } : {},
      )
      return reply.code(204).send()
    } catch (error) {
      return handleError(error, reply)
    }
  })
}
