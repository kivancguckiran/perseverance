// WP38 (ADR-0038): base-path yardımcıları. Vite `base` build-time'da belirlenir
// (kökte '/', base'li kurulumda '/workspace/' gibi). Router navigasyonları
// `basepath` ile otomatik prefix'lenir; buradaki yardımcılar router DIŞI
// kök-mutlak kullanımlar içindir (window.location, raw <a href>, SW kaydı).
// `new URL('/yol', apiBaseUrl)` deseni base'i düşürdüğünden yasaktır — string
// birleştirme (`${apiBaseUrl}/yol`) kullanılır.

export const baseUrl = import.meta.env.BASE_URL ?? '/'

// '' (kök) veya '/workspace' — sonda '/' olmadan.
export const basePath = baseUrl.replace(/\/+$/, '')

// Kök-mutlak bir yolu base altına taşır: withBase('/login') → '/workspace/login'
// (kökte '/login'). withBase('/') base'in kendisine ('/workspace/' | '/') çözülür.
export function withBase(path: string): string {
  if (path === '/') return `${basePath}/`
  return `${basePath}${path}`
}
