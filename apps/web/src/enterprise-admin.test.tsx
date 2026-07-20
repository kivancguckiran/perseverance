import { describe, expect, it } from 'vitest'
import { destructiveConfirmationMatches } from './enterprise-admin'
describe('enterprise admin authorization affordances', () => {
  it('requires exact tenant re-auth confirmation', () => {
    expect(destructiveConfirmationMatches('Tenant A', 'Tenant A')).toBe(true)
    expect(destructiveConfirmationMatches('tenant a', 'Tenant A')).toBe(false)
  })
})
