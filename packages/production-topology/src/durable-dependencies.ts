import { createHash, createHmac } from 'node:crypto'

const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest()
const encodePath = (value: string) =>
  value
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>
  get(key: string): Promise<Uint8Array>
  delete(key: string): Promise<void>
  ready(): Promise<boolean>
}

export class S3CompatibleObjectStore implements ObjectStore {
  readonly endpoint: URL
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string

  constructor(input: {
    endpoint: string
    region?: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
  }) {
    this.endpoint = new URL(input.endpoint)
    this.region = input.region ?? 'us-east-1'
    this.bucket = input.bucket
    this.accessKeyId = input.accessKeyId
    this.secretAccessKey = input.secretAccessKey
  }

  async #request(
    method: string,
    key: string | null,
    body: Uint8Array = new Uint8Array(),
    contentType = 'application/octet-stream',
  ) {
    const now = new Date()
    const timestamp = now
      .toISOString()
      .replaceAll(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z')
    const date = timestamp.slice(0, 8)
    const objectPath = key === null ? '' : `/${encodePath(key)}`
    const canonicalUri = `/${encodeURIComponent(this.bucket)}${objectPath}`
    const payloadHash = sha256(body)
    const host = this.endpoint.host
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const scope = `${date}/${this.region}/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      timestamp,
      scope,
      sha256(canonicalRequest),
    ].join('\n')
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, date)
    const regionKey = hmac(dateKey, this.region)
    const serviceKey = hmac(regionKey, 's3')
    const signingKey = hmac(serviceKey, 'aws4_request')
    const signature = createHmac('sha256', signingKey)
      .update(stringToSign)
      .digest('hex')
    const response = await fetch(new URL(canonicalUri, this.endpoint), {
      method,
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'content-type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': timestamp,
      },
      ...(method === 'PUT' ? { body: Buffer.from(body) } : {}),
    })
    return response
  }

  async ensureBucket() {
    const response = await this.#request('PUT', null)
    if (!response.ok && response.status !== 409)
      throw new Error(`OBJECT_BUCKET_CREATE_FAILED:${response.status}`)
  }

  async put(key: string, body: Uint8Array, contentType?: string) {
    const response = await this.#request('PUT', key, body, contentType)
    if (!response.ok) throw new Error(`OBJECT_PUT_FAILED:${response.status}`)
  }

  async get(key: string) {
    const response = await this.#request('GET', key)
    if (!response.ok) throw new Error(`OBJECT_GET_FAILED:${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  async delete(key: string) {
    const response = await this.#request('DELETE', key)
    if (!response.ok && response.status !== 404)
      throw new Error(`OBJECT_DELETE_FAILED:${response.status}`)
  }

  async ready() {
    try {
      const response = await fetch(
        new URL('/minio/health/ready', this.endpoint),
      )
      return response.ok
    } catch {
      return false
    }
  }
}

export interface DurableEventBroker {
  publish(routingKey: string, message: Record<string, unknown>): Promise<void>
  ready(): Promise<boolean>
}

export class RabbitMqManagementBroker implements DurableEventBroker {
  readonly endpoint: URL
  readonly username: string
  readonly password: string
  readonly queue: string

  constructor(input: {
    endpoint: string
    username: string
    password: string
    queue: string
  }) {
    this.endpoint = new URL(input.endpoint)
    this.username = input.username
    this.password = input.password
    this.queue = input.queue
  }

  #headers() {
    return {
      authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      'content-type': 'application/json',
    }
  }

  async ensureQueue() {
    const response = await fetch(
      new URL(
        `/api/queues/%2F/${encodeURIComponent(this.queue)}`,
        this.endpoint,
      ),
      {
        method: 'PUT',
        headers: this.#headers(),
        body: JSON.stringify({
          durable: true,
          auto_delete: false,
          arguments: {},
        }),
      },
    )
    if (!response.ok)
      throw new Error(`BROKER_QUEUE_CREATE_FAILED:${response.status}`)
    const binding = await fetch(
      new URL(
        `/api/bindings/%2F/e/amq.direct/q/${encodeURIComponent(this.queue)}`,
        this.endpoint,
      ),
      {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({ routing_key: 'ha.event', arguments: {} }),
      },
    )
    if (!binding.ok) throw new Error(`BROKER_BINDING_FAILED:${binding.status}`)
  }

  async publish(routingKey: string, message: Record<string, unknown>) {
    const response = await fetch(
      new URL('/api/exchanges/%2F/amq.direct/publish', this.endpoint),
      {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          properties: { delivery_mode: 2, content_type: 'application/json' },
          routing_key: routingKey,
          payload: JSON.stringify(message),
          payload_encoding: 'string',
        }),
      },
    )
    if (!response.ok)
      throw new Error(`BROKER_PUBLISH_FAILED:${response.status}`)
    const result = (await response.json()) as { routed?: boolean }
    if (!result.routed) throw new Error('BROKER_MESSAGE_NOT_ROUTED')
  }

  async ready() {
    try {
      const response = await fetch(
        new URL('/api/health/checks/alarms', this.endpoint),
        { headers: this.#headers() },
      )
      return response.ok
    } catch {
      return false
    }
  }
}

export async function httpDependencyReady(url: string) {
  try {
    const response = await fetch(url)
    return response.ok
  } catch {
    return false
  }
}
