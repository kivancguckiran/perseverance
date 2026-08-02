//  kullanıcı content key'i ile prompt/model_output şifreleme yardımcıları
// (ADR-0037). Object storage'a yazılan içerik, kullanıcı workspace'lerinde
// EnvelopeV1 JSON olarak durur; düz metin yalnız bellekte yaşar.
import {
  EnvelopeEncryption,
  UserContentKmsProvider,
  type EncryptionContextV1,
  type EnvelopeV1,
} from '@perseverance/workspace-security'

export interface UserContentKeyMaterial {
  contentKey: Uint8Array
  keyVersion: string
}

export const USER_CONTENT_PROVIDER_NAME = 'user-content-key'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function parseUserContentEnvelope(bytes: Uint8Array): EnvelopeV1 | null {
  if (bytes.byteLength === 0 || bytes[0] !== 0x7b) return null
  try {
    const value = JSON.parse(decoder.decode(bytes)) as EnvelopeV1
    if (
      value.formatVersion === 1 &&
      value.algorithm === 'AES-256-GCM' &&
      value.encryptedDek?.provider === USER_CONTENT_PROVIDER_NAME
    )
      return value
    return null
  } catch {
    return null
  }
}

export async function encryptUserContent(
  key: UserContentKeyMaterial,
  context: EncryptionContextV1,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const crypto = new EnvelopeEncryption(
    new UserContentKmsProvider(key.contentKey, key.keyVersion),
  )
  return encoder.encode(
    JSON.stringify(await crypto.encrypt(context, plaintext)),
  )
}

export async function decryptUserContent(
  key: UserContentKeyMaterial,
  context: EncryptionContextV1,
  envelope: EnvelopeV1,
): Promise<Uint8Array> {
  const crypto = new EnvelopeEncryption(
    new UserContentKmsProvider(key.contentKey, key.keyVersion),
  )
  return await crypto.decrypt(context, envelope)
}
