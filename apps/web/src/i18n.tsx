import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Locale = 'en' | 'tr'

const STORAGE_KEY = 'perseverance.locale.v1'
const LocaleContext = createContext<{
  locale: Locale
  setLocale: (locale: Locale) => void
}>({ locale: 'en', setLocale: () => undefined })

function browserLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  return navigator.languages.some(
    (language) => language.toLowerCase().split('-')[0] === 'tr',
  )
    ? 'tr'
    : 'en'
}

export function localize(english: string, turkish: string) {
  return typeof document !== 'undefined' &&
    document.documentElement.lang === 'tr'
    ? turkish
    : english
}

export function initialLocale(
  storage: Pick<Storage, 'getItem'> | undefined,
): Locale {
  const stored = storage?.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'tr') return stored
  return browserLocale()
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Keep SSR deterministic; apply the browser preference immediately after hydration.
  const [locale, setLocaleState] = useState<Locale>('en')

  useEffect(() => {
    setLocaleState(initialLocale(window.localStorage))
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((nextLocale: Locale) => {
    document.documentElement.lang = nextLocale
    window.localStorage.setItem(STORAGE_KEY, nextLocale)
    setLocaleState(nextLocale)
  }, [])

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  )
}

export function useLocale() {
  return useContext(LocaleContext)
}

export function useTranslations() {
  const { locale } = useLocale()
  return useCallback(
    (english: string, turkish: string) => (locale === 'tr' ? turkish : english),
    [locale],
  )
}

export function LanguageSwitcher({
  variant = 'floating',
}: {
  variant?: 'floating' | 'settings'
}) {
  const { locale, setLocale } = useLocale()
  return (
    <div
      className={`language-switcher is-${variant}`}
      role="group"
      aria-label="Language / Dil"
    >
      <button
        type="button"
        aria-pressed={locale === 'en'}
        onClick={() => setLocale('en')}
      >
        EN
      </button>
      <button
        type="button"
        aria-pressed={locale === 'tr'}
        onClick={() => setLocale('tr')}
      >
        TR
      </button>
    </div>
  )
}
