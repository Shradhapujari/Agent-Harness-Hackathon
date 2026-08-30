# Hush Design Direction

<!-- impeccable:design-schema 1 -->

## Visual Theme & Atmosphere

Hush is a midnight incident room: dense enough for an operator, quiet enough to preserve judgment. The interface is a causal record rather than a collection of dashboard cards. Real graph state, evidence, actions, and approval data are the visual protagonists.

The system combines the strongest applicable principles in VoltAgent's `awesome-design-md` collection: IBM Carbon's square enterprise precision, Linear's stepped dark surfaces and scarce accent, Sentry's incident narrative, and ClickHouse's insistence that real technical material replace abstract decoration. Hush does not copy any brand identity or proprietary asset.

## Color Palette & Roles

- `#080b12` — canvas; the anchor surface.
- `#10151f` — surface 1; primary working region.
- `#171e2a` — surface 2; selected or grouped data.
- `#242d3c` — strong hairline and pressed surface.
- `#f4f7fb` — primary ink.
- `#aeb8c7` — secondary ink, maintaining 4.5:1 contrast.
- `#d8ff5f` — Hush action signal. Reserve for the primary actionable control, live focus, and the currently active graph node.
- `#f4b44b` — warning and pending human authority.
- `#ff6b6b` — destructive, failed, or denied state.
- `#53d6a2` — healthy, completed, or recovered state.

Do not use atmospheric gradients. Hierarchy comes from stepped surfaces, 1px rules, and typography. Action color never becomes decorative fill.

## Typography Rules

Use IBM Plex Sans for interface and display text: weight 300 for the 42–64px page title, 400 for body, and 600 for operational emphasis. Apply slight positive tracking to body copy. Use IBM Plex Mono only for run IDs, graph nodes, tool names, arguments, and measurements.

Hierarchy is functional: current incident and decision first, graph position second, evidence and history third. Labels stay sentence case rather than tracked all-caps except compact machine states such as LIVE or N6.

## Component Styling

- Buttons, selects, inputs, panels, and drawers have square corners.
- The primary button is acid-lime with near-black text; secondary and destructive controls use bordered dark surfaces until pressed.
- Inputs use a dark surface and a strong bottom rule; focus changes the rule and outline to the action signal.
- Working regions are flat bands separated by hairlines, not floating cards.
- Status always combines text with color. Completed, active, pending, failed, and idle must remain distinguishable without hue alone.
- Approval is the only interruptive surface. It enters as an anchored bottom workbench, shows exact action data, and gives denial and approval equal visual clarity without equal emphasis.

## Layout Principles

Use a 4px spacing base with 8, 12, 16, 24, 32, and 48px steps. The desktop frame is a 12-column work surface capped at 1600px. The signal field occupies eight columns and the causal relay four. Evidence and actions form two equal registers below.

Whitespace is compact inside live operational regions and generous between decision groups. One horizontal service rail establishes readiness before the incident surface. Avoid repeated same-size cards and avoid headline-plus-metric dashboard templates.

## Depth & Elevation

The default surface is flat. Surface changes and 1px borders establish containment. Only the human checkpoint may cast a soft upward shadow because it changes authority and overlays the work surface.

## Motion

One authored moment carries the incident: the signal trace resolves from noise into a stable causal path as the graph advances. The active-node marker may pulse gently. Everything respects reduced motion; data and controls remain complete without animation.

## Responsive Behavior

- Above 1024px: signal and agent relay share an 8/4 split; evidence and action registers share a row.
- From 672–1024px: the relay moves below the signal and renders in a compact multi-column sequence.
- Below 672px: all regions become single-column; controls and decision buttons reach at least 48px; technical values scroll rather than shrink.
- The approval workbench becomes a full-width, vertically scrollable sheet while preserving exact arguments and evidence.

## Do

- Use one accent for action and focus.
- Show real graph nodes, evidence provenance, arguments, and state transitions.
- Preserve square geometry, surface steps, 1px rules, and minimum 44–48px touch targets.
- Let dense data become more compact on smaller viewports by changing topology, not font legibility.

## Don't

- Do not use glass, glow, gradients, decorative dashboards, or pill-shaped controls.
- Do not use the action signal for body copy or passive decoration.
- Do not hide destructive arguments or approval evidence on compact screens.
- Do not introduce a second visual metaphor; the causal incident record owns the surface.
