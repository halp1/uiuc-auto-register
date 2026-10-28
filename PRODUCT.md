# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Bun (one process, `Bun.serve` with HTML imports), React, Tailwind CSS v4 via `bun-plugin-tailwind`, shadcn/ui components, SQLite via `bun:sqlite`, `Bun.WebView` for the headless Banner session. Deployed with Docker on Coolify behind Cloudflare Access.

## Users

One UIUC student per instance, running their own copy. They are technical enough to self-host, and they use it during registration season to land seats in full courses. They check the dashboard mostly from a desktop while setting things up, and from their phone for quick glances and approving registrations.

## Product Purpose

Watch live Banner seat counts for the course sections a student wants and register the moment a seat opens, either automatically or after one tap. Success is getting into a wanted course faster than a human refreshing Banner, with zero risk to the student's existing schedule.

## Positioning

It reads Banner's live seat counts (not Course Explorer's ten-minute-old status) and registers through the student's own logged-in session, with a full TOTP login so it never needs a human for MFA. A student's existing registrations are protected by layered, code-enforced safety checks.

## Operating Context

- Registration terms are identified by Banner term codes (Spring 2027 = 120271).
- Many courses need linked sections (lecture plus discussion or lab). A "bundle" is one all-or-nothing set of CRNs; a wanted course holds a ranked list of bundles, or "any valid combination" with day, time, and instructor exclusions.
- The student may enter a registration time ticket; the app logs in early and submits at the opening second.
- Notifications go to a Discord bot DM (with Register / Skip buttons and /status, /pause, /resume) and browser web push. Every route is off until the student enables it.
- Three modes: Simulated (default, fake Banner), Rehearsal (real login, read only), Live (real registration, needs an env flag plus a typed confirmation in the UI).
- UIUC has no waitlists enabled.

## Capabilities and Constraints

- Never alter the student's existing schedule outside the exact bundle being added (and at most one explicitly named swap drop). Swaps stay locked until the student proves them on a Winter or Summer term.
- Seat polling every 10 seconds with jitter by default; slower overnight.
- Credentials live only in the environment; everything else is configured in the website.
- No app-level auth: Cloudflare Access protects the deployment.

## Brand Commitments

The interface must look like the Vercel dashboard: black background, hairline gray borders, Geist Sans and Geist Mono, pill badges, colored status dots, dense list rows, a left sidebar with a Find field. The student supplied two reference screenshots (Vercel project overview and deployments list). Dark only.

## Evidence on Hand

No marketing claims. Real data comes from Banner and Course Explorer at runtime; demo data in simulated mode must be labeled simulated.

## Product Principles

1. Never surprise the schedule: every write is explicit, scoped, and verified afterward.
2. Status at a glance: the mode, the poller, and the session are always visible.
3. Speed when it matters: seats are checked in seconds and registration fires without waiting on a login.
4. Quiet by default: nothing notifies until the student turns it on.

## Accessibility & Inclusion

Status is never conveyed by color alone (dots always pair with a text label). Keyboard reachable controls, visible focus, WCAG AA contrast on the dark theme.
