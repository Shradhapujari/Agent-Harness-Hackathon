# Hush Design Direction

<!-- impeccable:design-schema 1 -->

## Visual Theme & Atmosphere

Hush is a causal incident record, not a dashboard. The interface answers three
questions in reading order: how many alarms fired, what single thing caused
them, and what the agent did about it.

The system is grounded in the **Linear** `DESIGN.md` from VoltAgent's
[`awesome-design-md`](https://github.com/voltagent/awesome-design-md)
collection. Linear's rule is that the product UI screenshot is the protagonist
and the marketing chrome is only a dark frame around it. Hush takes that
literally: the live run state — alerts, graph position, evidence, actions,
approval — is the screenshot. Panels are a frame and nothing more. Hush borrows
the system, not the brand: no Linear wordmark, logo, or proprietary typeface.

## Color Palette & Roles

Linear's four-step surface ladder, verbatim:

- `#010102` — canvas. Near-black with a faint blue tint. Never `#000000`.
- `#0f1011` — surface 1; every panel.
- `#141516` — surface 2; rows, tiles, and chips inside a panel.
- `#18191a` — surface 3; the selected or emphasised row.
- `#191a1b` — surface 4; the deepest nested tag.
- `#23252a` / `#34343a` / `#3e3e44` — hairline, strong, tertiary.

Ink: `#f7f8f8` primary, `#d0d6e0` muted, `#8a8f98` subtle, `#62666d` tertiary.

The single chromatic accent is **Linear lavender `#5e6ad2`** (hover `#828fff`,
focus `#5e69d1`). It is scarce by rule, and in Hush it means exactly one thing:
_this is the live or decisive element._ It appears on the brand mark, the
primary button, focus rings, the currently executing graph node, the confidence
meter, and the one alert triage named as the root cause. Nothing else.

Severity and outcome hues come from Linear's **in-product** priority palette,
which the source `DESIGN.md` documents as living inside product surfaces rather
than on marketing chrome: `#eb5757` critical/denied/failed, `#f2994a`
warning/degraded, `#27a644` recovered. They colour a 2–3px edge or a small
pip — never a panel fill, and never a second accent.

Every state pairs colour with text. Done, active, waiting, denied, and executed
stay distinguishable without hue.

## Typography Rules

`SF Pro Display` with `-apple-system` and `Inter` fallbacks, matching Linear's
documented substitute stack. Display weight 600, body 400; Linear resists 700+.
Tracking goes negative as size grows — `-1.8px` at 56px, `-0.4px` at 22px,
`-0.05px` at body. The eyebrow is the one positive-tracked style (`+0.4px`),
marking it as taxonomy rather than voice.

A monospace face (`SF Mono` / `JetBrains Mono`) is reserved for machine values:
run IDs, graph node IDs, fingerprints, tool names, arguments, counts, and
durations. Never for prose.

## Component Styling

- Radius scale `4 / 6 / 8 / 12 / 16px`. Buttons and inputs at 8px, panels at
  12px, the verdict band at 16px. Pills only for status chips.
- Primary button is lavender with white text. Secondary and deny are
  surface-1 with a strong hairline; deny reddens on hover only.
- Inputs sit on surface-2 with a hairline-strong border; focus is a 2px
  lavender ring at 50% opacity.
- Panels are level-1 lifts: surface-1 on canvas with a 1px hairline. No
  shadows.
- Approval is the only interruptive surface and the only element permitted a
  shadow, because it overlays the work and changes who holds authority.

## Layout Principles

4px base with `4 / 8 / 12 / 16 / 24 / 32 / 48` steps. The shell caps at 1440px.

Reading order is the incident's own order:

1. **Verdict band** — the alarm count and the root cause, side by side, with a
   `primary | symptom | noise` split bar underneath. The largest type on the
   page is the alarm count, because that is the first question.
2. **Storm (8 cols) + agent graph (4 cols)** — lanes plot every alert at its
   real `startsAt` against its real `labels.layer`, ordered lowest layer first.
   The graph relay lists all eleven nodes with per-node timings.
3. **Run timeline** — every state transition the controller wrote.
4. **Evidence and action registers** — two equal columns.

The dark canvas is the whitespace. Sections separate by lifting onto surface-1,
not by empty gutters.

## Depth & Elevation

Flat by default. Hierarchy is surface step plus 1px hairline. Only the approval
workbench casts a shadow.

## Motion

Motion is reserved for the one thing currently alive: the active graph node's
marker and the harness dot pulse, and the approval drawer's slide. Meters and
the split bar ease when their values change. Everything respects
`prefers-reduced-motion`; no data depends on animation.

**No decorative visualisation.** An earlier revision drew a hardcoded SVG
"signal trace" that was not connected to any data. Every mark on the page must
now be readable back to a field in `state.json`.

## Responsive Behavior

- Above 1024px: storm and relay split 8/4; evidence and actions share a row.
- 768–1024px: all decks collapse to one column; the relay follows the storm.
- Below 768px: the service rail scrolls horizontally under the brand; the
  headline figure drops 56px → 40px; lane labels narrow; the timeline drops its
  detail column onto a second line; controls reach 44px.
- The approval workbench becomes a scrollable full-width sheet and never hides
  the exact arguments or evidence IDs.

## Do

- Reserve lavender for the live or decisive element, and nothing else.
- Draw only from real run state; label every mark with its source field.
- Keep the surface ladder — don't skip levels to create emphasis.
- Pair every colour-coded state with a word.

## Don't

- Don't use `#000000`, atmospheric gradients, glass, or spotlight cards.
- Don't introduce a second chromatic accent on the chrome.
- Don't pill-round buttons or inputs.
- Don't render a chart that isn't backed by data.
- Don't hide destructive arguments or approval evidence on compact screens.
