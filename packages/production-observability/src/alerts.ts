export interface BurnRateWindow {
  shortWindowMinutes: number
  longWindowMinutes: number
  threshold: number
  severity: 'page' | 'ticket'
}

export const MULTI_WINDOW_BURN_RATE: readonly BurnRateWindow[] = [
  {
    shortWindowMinutes: 5,
    longWindowMinutes: 60,
    threshold: 14.4,
    severity: 'page',
  },
  {
    shortWindowMinutes: 30,
    longWindowMinutes: 360,
    threshold: 6,
    severity: 'page',
  },
  {
    shortWindowMinutes: 120,
    longWindowMinutes: 720,
    threshold: 3,
    severity: 'ticket',
  },
  {
    shortWindowMinutes: 360,
    longWindowMinutes: 4320,
    threshold: 1,
    severity: 'ticket',
  },
]

export function evaluateBurnRate(
  input: {
    objective: number
    shortGood: number
    shortTotal: number
    longGood: number
    longTotal: number
  },
  rule: BurnRateWindow,
) {
  const budget = 1 - input.objective
  if (budget <= 0 || input.shortTotal <= 0 || input.longTotal <= 0) return false
  const shortBurn = (1 - input.shortGood / input.shortTotal) / budget
  const longBurn = (1 - input.longGood / input.longTotal) / budget
  return shortBurn >= rule.threshold && longBurn >= rule.threshold
}

export class AlertLifecycle {
  state: 'inactive' | 'firing' = 'inactive'
  evaluate(firing: boolean) {
    const previous = this.state
    this.state = firing ? 'firing' : 'inactive'
    return { previous, current: this.state }
  }
}
