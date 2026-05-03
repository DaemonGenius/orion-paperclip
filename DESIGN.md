# Paperclip Design Manifest

## Purpose

Paperclip is a dense AI-agent company control plane. Its interface should help an operator understand companies, agents, tasks, costs, approvals, knowledge, and execution state at a glance.

This file defines the optional `vaporwave-neo-tokyo` visual direction. It is an AI-readable design manifest: concise, token-heavy, and specific enough for designers, engineers, and agents to generate consistent Paperclip screens.

This complements the coded design system and the `/design-guide` route. It does not replace `ui/src/index.css`, reusable UI components, Storybook, or implementation specs.

## Theme Identity

Name: `Vaporwave Neo Tokyo`

Mood: a dusk-lit Neo Tokyo operations console. The theme should feel like a calm command room above the city: neon signage color, midnight glass, soft grid light, and precise telemetry.

Product posture:

- Serious and operational.
- Dense but scannable.
- Keyboard-first and power-user friendly.
- Visual effects support focus and state, never decoration for its own sake.

Avoid:

- Poster-like cyberpunk.
- Anime mascots or character portraits.
- Rain streets, cars, weapons, or cinematic city scenes.
- Excessive bloom, lens flare, or glow.
- Decorative orbs, blob backgrounds, and all-purple washes.

## Color Tokens

Use semantic tokens in code and keep exact theme values in sync with `ui/src/index.css` once implemented.

| Token | Hex | Usage |
| --- | --- | --- |
| `--vnt-background` | `#070816` | App background, deepest page base. |
| `--vnt-background-alt` | `#0d0920` | Black-plum background variation for large empty regions. |
| `--vnt-surface` | `#11152a` | Primary panel and card surface. |
| `--vnt-surface-raised` | `#171b34` | Hovered, selected, or elevated panels. |
| `--vnt-surface-glass` | `rgba(17, 21, 42, 0.78)` | Frosted/glass panel backgrounds. |
| `--vnt-border` | `#6f63a6` | Lavender hairline borders and separators. |
| `--vnt-border-subtle` | `rgba(111, 99, 166, 0.34)` | Default low-contrast dividers. |
| `--vnt-primary` | `#ff4fd8` | Neon pink primary identity, selected project accents. |
| `--vnt-primary-soft` | `rgba(255, 79, 216, 0.16)` | Primary hover and selected backgrounds. |
| `--vnt-accent` | `#38f5ff` | Aqua focus, active control outlines, links. |
| `--vnt-accent-soft` | `rgba(56, 245, 255, 0.14)` | Aqua hover and focus fill. |
| `--vnt-secondary` | `#a78bfa` | Lavender secondary highlights and chart series. |
| `--vnt-warning` | `#ffb86b` | Sunset peach warnings and priority highlights. |
| `--vnt-warning-strong` | `#ff8f3d` | High-warning borders or badges. |
| `--vnt-success` | `#4dffb3` | Synced, done, healthy, and successful states. |
| `--vnt-error` | `#ff4d6d` | Failed, blocked, destructive, or rejected states. |
| `--vnt-text` | `#f8f7ff` | Primary readable text. |
| `--vnt-text-secondary` | `#c8c3e8` | Secondary text, descriptions, metadata. |
| `--vnt-text-muted` | `#8e89b6` | Muted labels, timestamps, placeholder text. |
| `--vnt-grid` | `rgba(56, 245, 255, 0.08)` | Low-opacity background grid lines. |
| `--vnt-scanline` | `rgba(248, 247, 255, 0.035)` | Optional scanline overlay. |

Chart mapping:

- `--chart-1`: aqua cyan `#38f5ff`
- `--chart-2`: neon pink `#ff4fd8`
- `--chart-3`: sunset peach `#ffb86b`
- `--chart-4`: lavender `#a78bfa`
- `--chart-5`: mint green `#4dffb3`

Status guidance:

- Success and sync states use mint green.
- Running or focused states use aqua cyan.
- Selected project identity may use the project color, with Orion-style magenta as the default example.
- Warnings and idle states use sunset peach or amber.
- Errors stay vivid but controlled; avoid large red fields unless the state is blocking.

## Typography

Keep Paperclip's compact type scale. Text is the primary visual element, so the theme must never sacrifice readability for atmosphere.

| Pattern | Recommended treatment |
| --- | --- |
| Page title | `text-xl font-bold`; primary text. |
| Section title | `text-lg font-semibold`; primary text. |
| Section heading | `text-sm font-semibold uppercase tracking-wide`; muted or secondary text. |
| Card title | `text-sm font-medium` or `text-sm font-semibold`; primary text. |
| Body | `text-sm`; primary or secondary text. |
| Tiny label | `text-xs`; muted text. |
| Mono identifier | `text-xs font-mono`; muted or secondary text. |
| Metric value | `text-2xl font-bold tabular-nums`; primary text. |
| Code/log text | `font-mono text-xs`; high contrast on deep surface. |

Rules:

- Do not use negative letter spacing.
- Do not scale font size with viewport width.
- Preserve monospace for task keys, IDs, run IDs, paths, logs, costs, and telemetry.
- Never place important text over high-contrast background art or glow.

## Spacing, Density, Radius

Paperclip is an operator tool, not a landing page. Preserve dense control-plane layouts.

- Use a 4px/8px spacing rhythm.
- Prefer compact rows, tables, and panels over large empty cards.
- Use whitespace to separate groups, not to create marketing-style drama.
- Cards and panels should use a maximum radius of 8px.
- Buttons and inputs may use existing Paperclip radii, but should remain compact.
- Pills, status chips, avatars, and dots may use full radius.
- Avoid oversized empty sections, hero blocks, and decorative card stacks.

## Surfaces and Effects

Glass panel treatment:

- Background: `--vnt-surface-glass`.
- Border: 1px solid `--vnt-border-subtle`.
- Text: `--vnt-text` or `--vnt-text-secondary`.
- Optional backdrop blur is allowed only when it does not reduce performance or legibility.
- Selected, live, or focused states may add a subtle glow:
  - Aqua: `0 0 0 1px rgba(56, 245, 255, 0.32), 0 0 18px rgba(56, 245, 255, 0.10)`
  - Pink: `0 0 0 1px rgba(255, 79, 216, 0.30), 0 0 18px rgba(255, 79, 216, 0.10)`

Background treatment:

- Use a low-opacity retro grid, scanline, or noise layer only in unused background regions.
- Keep the main content surface clean enough for long work sessions.
- Effects must not sit behind dense text tables unless opacity is extremely low.
- Respect `prefers-reduced-motion`; animated shimmer, scanline movement, or glow pulses must stop or become static.

## Components

Sidebar and navigation:

- Selected nav items use a neon side rail plus subtle selected background.
- Hover states use aqua or lavender tint, not large bright fills.
- Project dots remain strong identity marks and should not be washed out by the theme.
- Live agent indicators may pulse gently in aqua; reduce motion must disable pulse.

Metric cards:

- Keep compact stat hierarchy: value first, label second, description third.
- Use a small telemetry icon in the upper right.
- Optional top or side accent line may use chart or status color.
- Avoid large pictorial icons or oversized empty panels.

Task rows:

- Preserve dense row height and metadata alignment.
- Use thin lavender separators.
- Status rings and project accents should remain visible at scan speed.
- Metadata columns should be quieter than task titles.
- Hover and keyboard focus use aqua cyan outlines or fills.

Charts:

- Use theme chart tokens consistently.
- Bars and legends must remain readable without relying on glow.
- Empty chart states use muted text on clean dark surfaces.
- Do not replace compact charts with decorative infographics.

Knowledge and org cards:

- Use compact glass cards with clear headings and metadata rows.
- Synced chips use mint green.
- Idle or waiting states use amber/peach.
- Role cards may use subtle neon top borders or node-link traces when they clarify relationships.
- Avoid decorative node webs that compete with labels and permissions.

Buttons, inputs, and controls:

- Primary actions use neon pink only when they are truly primary.
- Secondary actions use dark glass with lavender border.
- Focus uses aqua cyan and must be visible on keyboard navigation.
- Icon-only buttons need tooltips when the icon is not obvious.

## Accessibility Rules

- Maintain readable contrast for primary and secondary text.
- Keyboard focus must be obvious in every interactive component.
- Color cannot be the only status indicator; pair it with text, icon, shape, or position.
- Glow and scanline effects must be subtle and reduced-motion safe.
- Do not put dense text directly on busy grids, signage, images, or high-noise textures.
- Verify mobile and desktop layouts for text clipping and overlap.

## AI Generation Rules

When generating design concepts or UI implementation from this manifest:

- Preserve Paperclip's actual layout: company rail, sidebar, top title/breadcrumb, dense content area, task rows, cards, charts, and data panels.
- No hero sections for operational pages.
- No characters, city scenes, random logos, cinematic backgrounds, or decorative mascot art.
- Prefer realistic dense app screenshots over concept art.
- Text must fit inside UI elements.
- Keep controls familiar: icon buttons, tabs, search inputs, filters, status chips, and compact tables.
- The theme should feel like Vaporwave Neo Tokyo, but the product must still read as a professional AI-company control plane.

## Implementation Notes

- Treat this file as stable prompt/context for future design generation.
- Keep exact token values synchronized with `ui/src/index.css` when the theme is implemented.
- Link this file from contributor docs wherever UI design workflows are described.
- Keep the root manifest focused on visual tokens and repeatable AI constraints.
- Do not duplicate every component rule from the full coded design system.

## Test and Review Criteria

- A designer or agent can read this file and recreate the Vaporwave Neo Tokyo direction without the original screenshots.
- The file contains exact token values, not vague color descriptions alone.
- The rules preserve Paperclip's dense operator-console UX.
- The file is short enough to be useful as persistent AI context.
- Any implemented theme using this manifest should be checked in `/design-guide`, Storybook, dashboard, project tasks, knowledge, and org chart surfaces.

## Assumptions

- `vaporwave-neo-tokyo` is optional.
- The current dark theme remains the default.
- This document describes visual direction and generation constraints, not a completed implementation of the theme in code.
