import { afterEach, describe, expect, it } from 'vitest'
import { initialLocale } from './i18n'

const originalNavigator = globalThis.navigator

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: originalNavigator,
  })
})

describe('locale selection', () => {
  it('uses a saved preference before browser locale', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { languages: ['tr-TR'] },
    })
    expect(initialLocale({ getItem: () => 'en' })).toBe('en')
  })

  it('uses Turkish for a Turkish browser when no preference is saved', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { languages: ['tr-TR', 'en-US'] },
    })
    expect(initialLocale({ getItem: () => null })).toBe('tr')
  })

  it('defaults other browser locales to English', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { languages: ['de-DE', 'en-US'] },
    })
    expect(initialLocale({ getItem: () => null })).toBe('en')
  })
})
