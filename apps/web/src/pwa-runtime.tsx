import { useEffect, useRef, useState } from 'react'

export const serviceWorkerUrl = '/sw.js?v=phase2-v2'

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
        const response = await fetch('/?connectivity=1', {
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
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker>()
  const reloadOnControllerChange = useRef(false)
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
      .register(serviceWorkerUrl, { scope: '/', updateViaCache: 'none' })
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
  return waitingWorker ? (
    <p className="pwa-update-banner" role="status">
      Yeni sürüm hazır. Açık akışınız kesilmeden istediğiniz zaman
      etkinleştirin.
      <button
        type="button"
        onClick={() => {
          reloadOnControllerChange.current = true
          waitingWorker.postMessage({ type: 'SKIP_WAITING' })
          setWaitingWorker(undefined)
        }}
      >
        Güncelle
      </button>
    </p>
  ) : null
}
