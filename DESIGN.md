# Design

The student pinned the visual world: the Vercel dashboard (two reference screenshots: project overview, project deployments). Dark only. Operate mode: precision and restraint, earned familiarity. Brand lives in exact details: hairlines, Geist, pill badges, status dots, dense rows.

## Tokens

Defined as CSS variables in `web/styles.css` and mapped into Tailwind v4 `@theme`.

| Token | Value | Use |
|---|---|---|
| `--background` | `#000000` | page |
| `--sidebar` | `#0a0a0a` | sidebar and top bar ground |
| `--surface` | `#0a0a0a` | list containers, panels |
| `--surface-2` | `#111111` | hover rows, inputs, selected nav item `#1a1a1a` |
| `--border` | `#1f1f1f` | hairlines between rows and around containers |
| `--border-strong` | `#2e2e2e` | inputs, buttons, pills |
| `--fg` | `#ededed` | primary text |
| `--fg-muted` | `#a1a1a1` | secondary text, metadata |
| `--fg-subtle` | `#707070` | placeholders (on `#111` still at least 4.5:1 for 14px labels where used for text, else decorative only) |
| `--accent` | `#0070f3` | primary action, active selection, the "Live" production-style pill |
| `--ready` | `#50e3c2` | open / registered dot |
| `--error` | `#ee0000` (text `#ff4d4d`) | error dot, failure |
| `--warning` | `#f5a623` | warnings, action required |
| `--violet` | `#8e4ec6` | pending approval |
| radius | 6px controls, 8px containers, 9999px pills |
| row height | 56 to 64px list rows, 36px controls, 32px compact controls |

## Type

- Geist Sans for everything; Geist Mono only for data: CRNs, section codes, times, term codes, counts in tables. Self-hosted from the `geist` package.
- Scale (rem, fixed): 0.75 (meta), 0.8125 (table), 0.875 (body/UI), 1 (section title), 1.5 (page title, weight 600, tracking -0.02em).
- Tabular numerals on every number that updates.

## Components

- Sidebar: 240px, Find field with `F` key hint, nav items 36px with 18px lucide icons, selected item `#1a1a1a` fill.
- Top bar: context switcher (term) with chevrons-up-down icon, right side actions.
- List container: one bordered rounded container, rows divided by hairlines, row hover `#0f0f0f`, `⋯` menu at the end of each row (lucide `Ellipsis`).
- Status: 8px dot plus text label, never color alone (e.g. dot + "Open 12").
- Pills: 1px `--border-strong`, 24px tall, icon + label. Filled `--accent` pill for the active/live state, matching Vercel's current production badge.
- Filter chips: dashed border pills like Vercel's "Add Filter" row.
- Action Required card: amber-bordered card at the sidebar foot for critical states (guard tripped, missing credentials).
- Buttons: secondary = black with `--border-strong`; primary = white fill black text (Vercel "Upgrade"); destructive = red text on dark.

## Motion

150 to 200ms ease-out on hover and state color changes. Seat changes flash the row background once (`--surface-2` to transparent, 600ms). No page-load choreography. Respects `prefers-reduced-motion`.

## Browser surfaces

Selection `#0070f3` at 35% alpha, caret `#ededed`, thin dark scrollbars (`#2e2e2e` thumb), focus ring 2px `#0070f3` with 2px offset on black.
