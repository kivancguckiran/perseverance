import { useCallback, useEffect, useRef, useState } from 'react'
import { baseUrl, withBase } from './base-path'
import { refreshStoredSession } from './self-hosted-auth'
import { useTranslations } from './i18n'

// (ADR-0038): SW, scope kuralı gereği base altından kaydedilir ve servis
// edilir; kökte withBase no-op'tur. Sürüm fixture-v1: sw.js scope-türevli precache
// listesine geçti.
export const serviceWorkerUrl = withBase('/sw.js?v=self-hosted-v1')

function applicationServerKey(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='),
  )
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0))
}

function pushDeviceId(namespace: string) {
  const key = `push-device-v1:${namespace}`
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const created = crypto.randomUUID()
  window.localStorage.setItem(key, created)
  return created
}

export function PushNotificationControl({
  apiBaseUrl,
  headers,
  namespace,
  online,
}: {
  apiBaseUrl: string
  headers: Record<string, string>
  namespace: string
  online: boolean
}) {
  const t = useTranslations()
  const [state, setState] = useState<
    'idle' | 'pending' | 'active' | 'denied' | 'unsupported'
  >('idle')
  const vapidPublicKey = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY as
    string | undefined
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window

  const subscribe = useCallback(async () => {
    if (!supported || !vapidPublicKey || !online) {
      setState('unsupported')
      return
    }
    setState('pending')
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      setState('denied')
      return
    }
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(vapidPublicKey),
    })
    const json = subscription.toJSON()
    if (!json.keys?.p256dh || !json.keys.auth)
      throw new Error('Push key materyali alınamadı')
    const response = await fetch(`${apiBaseUrl}/v1/push-subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        deviceId: pushDeviceId(namespace),
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        expiresAt: subscription.expirationTime
          ? new Date(subscription.expirationTime).toISOString()
          : null,
      }),
    })
    if (!response.ok) throw new Error('Push subscription kaydedilemedi')
    setState('active')
  }, [apiBaseUrl, headers, namespace, online, supported, vapidPublicKey])

  useEffect(() => {
    if (!supported || !online) return
    const refresh = (event: MessageEvent) => {
      if (event.data?.type === 'PUSH_SUBSCRIPTION_CHANGED')
        void subscribe().catch(() => setState('idle'))
    }
    const signOut = () => {
      const deviceId = pushDeviceId(namespace)
      void fetch(
        `${apiBaseUrl}/v1/push-devices/${encodeURIComponent(deviceId)}/revoke`,
        { method: 'POST', headers },
      ).finally(() =>
        window.localStorage.removeItem(`push-device-v1:${namespace}`),
      )
    }
    navigator.serviceWorker.addEventListener('message', refresh)
    window.addEventListener('perseverance:sign-out', signOut)
    if (Notification.permission === 'granted' && state === 'idle')
      void subscribe().catch(() => setState('idle'))
    return () => {
      navigator.serviceWorker.removeEventListener('message', refresh)
      window.removeEventListener('perseverance:sign-out', signOut)
    }
  }, [apiBaseUrl, headers, namespace, online, state, subscribe, supported])

  if (!supported || !vapidPublicKey) return null
  return (
    <button
      className="push-control"
      type="button"
      disabled={!online || state === 'pending' || state === 'active'}
      aria-label={t(
        'Enable approval notifications on this device',
        'Approval bildirimlerini bu cihazda etkinleştir',
      )}
      onClick={() => void subscribe().catch(() => setState('idle'))}
    >
      {state === 'active'
        ? t('Notifications on', 'Bildirimler açık')
        : state === 'pending'
          ? t('Enabling notifications…', 'Bildirim açılıyor…')
          : state === 'denied'
            ? t('Notification permission denied', 'Bildirim izni reddedildi')
            : t('Enable notifications', 'Bildirimleri aç')}
    </button>
  )
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    let active = true
    const update = async () => {
      if (!navigator.onLine) {
        if (active) setOnline(false)
        return
      }
      try {
        const response = await fetch(`${baseUrl}?connectivity=1`, {
          method: 'HEAD',
          cache: 'no-store',
        })
        if (active) setOnline(response.ok)
      } catch {
        if (active) setOnline(false)
      }
    }
    void update()
    const interval = window.setInterval(() => void update(), 2_000)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

export function PwaRuntime() {
  const t = useTranslations()
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker>()
  const [notificationResolutionError, setNotificationResolutionError] =
    useState(false)
  const reloadOnControllerChange = useRef(false)
  // PWA yeniden açılışında oturum, refresh token ile parolasız sürer.
  // Content key kilidi ayrıdır; içerik gerektiğinde sunucu 428 döner ve
  // kullanıcı /login üzerinden parolasını yeniden girer.
  useEffect(() => {
    const apiBaseUrl =
      (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
      'http://127.0.0.1:3100'
    const attempt = () => void refreshStoredSession(apiBaseUrl)
    attempt()
    const timer = setInterval(attempt, 10 * 60_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    const controllerChanged = () => {
      if (reloadOnControllerChange.current) window.location.reload()
    }
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      controllerChanged,
    )
    void navigator.serviceWorker
      .register(serviceWorkerUrl, { scope: baseUrl, updateViaCache: 'none' })
      .then((registration) => {
        if (registration.waiting && navigator.serviceWorker.controller)
          setWaitingWorker(registration.waiting)
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          installing?.addEventListener('statechange', () => {
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            )
              setWaitingWorker(installing)
          })
        })
      })
    return () => {
      reloadOnControllerChange.current = false
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        controllerChanged,
      )
    }
  }, [])

  useEffect(() => {
    const url = new URL(window.location.href)
    const notificationId = url.searchParams.get('notification')
    if (
      !notificationId ||
      (url.searchParams.has('organization') &&
        url.searchParams.has('workspace'))
    )
      return
    const runtimeAuth = (
      window as typeof window & {
        __PERSISTENT_AUTH__?: { accessToken?: string }
      }
    ).__PERSISTENT_AUTH__
    const apiBaseUrl =
      (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined) ??
      'http://127.0.0.1:3100'
    void fetch(
      `${apiBaseUrl}/v1/notifications/${encodeURIComponent(notificationId)}`,
      {
        cache: 'no-store',
        headers: runtimeAuth?.accessToken
          ? { authorization: `Bearer ${runtimeAuth.accessToken}` }
          : {},
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('notification unavailable')
        return (await response.json()) as {
          sessionId: string
          organizationId: string
          workspaceId: string
        }
      })
      .then((resolution) => {
        url.pathname = withBase(
          `/sessions/${encodeURIComponent(resolution.sessionId)}`,
        )
        url.searchParams.set('organization', resolution.organizationId)
        url.searchParams.set('workspace', resolution.workspaceId)
        window.location.replace(url.href)
      })
      .catch(() => setNotificationResolutionError(true))
  }, [])

  return (
    <>
      {notificationResolutionError ? (
        <p className="pwa-update-banner" role="alert">
          {t(
            'This notification is no longer valid or is unavailable to this account.',
            'Bu bildirim artık geçerli değil veya bu hesap için erişilebilir değil.',
          )}
        </p>
      ) : null}
      {waitingWorker ? (
        <p className="pwa-update-banner" role="status">
          {t(
            'A new version is ready. Activate it whenever you like without interrupting your current flow.',
            'Yeni sürüm hazır. Açık akışınız kesilmeden istediğiniz zaman etkinleştirin.',
          )}
          <button
            type="button"
            onClick={() => {
              reloadOnControllerChange.current = true
              waitingWorker.postMessage({ type: 'SKIP_WAITING' })
              setWaitingWorker(undefined)
            }}
          >
            {t('Update', 'Güncelle')}
          </button>
        </p>
      ) : null}
    </>
  )
}
