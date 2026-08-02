# Design — Perseverance

A locked semantic design system for the Perseverance agent workbench. App
surfaces share this system; page-specific styles may extend roles but must not
introduce a second theme layer.

## Genre

Modern-minimal, technical, and security-conscious.

## Macrostructure family

- App pages: Workbench — conversation is primary; history and activity are supporting rails.
- Authentication pages: Long Document — one clear task, restrained supporting copy.
- File pages: Index-First — path and content are the hierarchy.

## Theme

- Paper: warm, low-chroma near-white.
- Ink: warm charcoal rather than pure black.
- Accent: restrained signal coral, reserved for focus and active state.
- Status: semantic warning, danger, success, and info roles; never colour-only.
- Commands and diffs: inverse ink surface used only where code needs separation.

Canonical values live in `tokens.css`; production CSS references named tokens only.

## Typography

- Display: Archivo, weight 700, roman.
- Body: Archivo, weight 400, roman.
- Mono: IBM Plex Mono, weight 400.
- Display tracking: `-0.02em`.
- Data and identifiers use tabular numerals.

## Spacing

The 4-point named scale in `tokens.css` is authoritative. Workbench chrome uses
tight `xs`/`sm` rhythm; reading surfaces use `md`/`lg` rhythm.

## Motion

- Keyboard navigation, composer submission, focus movement, and core rail navigation: no animation.
- State transitions only: `opacity` and `transform`, 120–220 ms.
- Drawer and modal entrances: 220 ms ease-out; exits are shorter.
- Reduced motion: opacity-only, at most 150 ms.

## Microinteractions stance

- Focus rings appear instantly.
- Success is silent when the changed state is visible.
- Approval status changes remain announced, with no decorative celebration.
- Functional running indicators may pulse; static navigation does not move.

## CTA voice

- Primary: filled ink or signal coral only for the single current action.
- Secondary: paper surface with a visible rule.
- Destructive: explicit verb and danger role; never colour alone.

## Per-page allowances

- App pages must not use decorative enrichment.
- Authentication and file pages use typography and rules only.
- Code, command, and diff content may use the inverse surface.

## What pages MUST share

- Paper, ink, accent, status roles, typography, focus ring, radius, and 4-point spacing scale.
- Conversation-first hierarchy and the same button/input state language.
- Approval decisions that expose risk, scope, expiry, and the breadth of each grant.

## What pages MAY differ on

- Rail presence and density according to viewport and task.
- File views may use a wider mono measure.
- Authentication views may narrow the content column.

## Exports

### tokens.css

`tokens.css` at the project root is the source of truth.

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(97% 0.008 48);
  --color-paper-2: oklch(94.5% 0.011 48);
  --color-ink: oklch(19% 0.014 42);
  --color-accent: oklch(57% 0.205 35);
  --font-display: 'Archivo', ui-sans-serif, system-ui, sans-serif;
  --font-body: 'Archivo', ui-sans-serif, system-ui, sans-serif;
  --font-outlier: 'IBM Plex Mono', ui-monospace, monospace;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG tokens.json

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(97% 0.008 48)", "$type": "color" },
    "ink": { "$value": "oklch(19% 0.014 42)", "$type": "color" },
    "accent": { "$value": "oklch(57% 0.205 35)", "$type": "color" }
  },
  "font": {
    "display": {
      "$value": "Archivo, ui-sans-serif, system-ui, sans-serif",
      "$type": "fontFamily"
    },
    "body": {
      "$value": "Archivo, ui-sans-serif, system-ui, sans-serif",
      "$type": "fontFamily"
    },
    "outlier": {
      "$value": "IBM Plex Mono, ui-monospace, monospace",
      "$type": "fontFamily"
    }
  },
  "space": {
    "sm": { "$value": "1rem", "$type": "dimension" },
    "md": { "$value": "1.5rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "120ms", "$type": "duration" },
    "short": { "$value": "220ms", "$type": "duration" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 97% 0.008 48;
  --foreground: 19% 0.014 42;
  --card: 94.5% 0.011 48;
  --card-foreground: 19% 0.014 42;
  --primary: 57% 0.205 35;
  --primary-foreground: 98% 0.008 48;
  --muted: 86% 0.014 48;
  --muted-foreground: 50% 0.018 44;
  --border: 86% 0.014 48;
  --input: 86% 0.014 48;
  --ring: 52% 0.215 35;
  --radius: 0.75rem;
}
```
