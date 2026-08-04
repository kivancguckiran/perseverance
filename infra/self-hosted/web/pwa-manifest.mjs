const PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/

export function pwaLaunchPath(basePath) {
  return basePath === '' ? '/' : `${basePath}/`
}

export function normalizePwaId(rawValue, basePath) {
  const value = rawValue || pwaLaunchPath(basePath)
  const segments = value.split('/').filter(Boolean)
  if (
    (value !== '/' && !PATH_PATTERN.test(value)) ||
    segments.some((segment) => segment === '.' || segment === '..')
  )
    throw new Error(
      `PWA_ID geçersiz (root-relative, query/fragment yok): ${value}`,
    )
  return value
}

export function configurePwaManifest(manifest, { basePath, pwaId }) {
  const launchPath = pwaLaunchPath(basePath)
  return {
    ...manifest,
    id: normalizePwaId(pwaId, basePath),
    start_url: launchPath,
    scope: launchPath,
    icons: (manifest.icons ?? []).map((icon) => ({
      ...icon,
      src: icon.src.startsWith('./')
        ? `${launchPath}${icon.src.slice(2)}`
        : icon.src,
    })),
  }
}
