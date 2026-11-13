# Chitragupta visual system

## Authority

The pinned source and adaptations are recorded in [monitor-ui/PROVENANCE.md](monitor-ui/PROVENANCE.md). Use the original Panel, IconTile, Button, SegmentBar and palette tokens. [Operating surface contract](monitor-ui/operations-design.md) records the current view behavior and reference evidence. The user requires improvement within this world, not a new visual identity.

## Colour and type

Graphite neutral surfaces, one hue-normalized signal accent and original light/dark OKLCH palettes. Geist body/UI; Geist Mono only for tool identifiers or data where useful. Original text tokens range from11px metadata to28px display. Seven original accent swatches and a custom hex drive --brand and derived signal colours. Unknown, configured, idle, attention and failure remain visibly distinct.

## Geometry

Sidebar240px expanded at xl,64px collapsed/medium; compact route picker below md. Navigation rows36px expanded, icon buttons40px. Original Panel: rounded-2xl canvas shell,6px shell padding, dashed36px icon tile and inset rounded-xl body. Thin KPI instruments use the same neutral surfaces, borders, radii and type hierarchy. Avoid nested decorative cards, invented palettes and oversized metric heroes.

## Information and interaction

Operate mode: measured KPIs, workload/duration encoding and bounded run table lead. Tool list/detail and readable health states replace raw schema/JSON views. Run rows have internal scroll, sticky column filters, sorting and pagination. Preserve readable labels, keyboard focus, empty/loading/error/disabled states, mobile overflow containment and reduced-motion rules.

Every number comes from recorded metadata or a labeled local observation. Missing usage/readiness is unknown rather than zero/free/working. Monitor reachability is separate from executor readiness. Cost remains an explicitly estimated bounded subtotal. The UI is read-only; installing a credential or registration is not proof of a task result.

## Assets and verification

Themes follow system/query choice and persist through l1.theme. Fonts/assets are local. Rebuild static assets, test actual rendered controls at1600×1100 and390×844 in light/dark, and capture current README screenshots under docs/screenshots. Preserve source provenance. Screenshots contain tool metadata only, never keys or private task content. Relative image links work across repository hosts; GitHub publication is currently deferred.
