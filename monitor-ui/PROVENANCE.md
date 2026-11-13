# Chitragupta UI reuse

Visual authority: private GitLab `ssm/Chitragupta` (project 7), commit `3094d86ed0a3dcfa7745dabbd2b0e5b40adfc328`, retrieved 2026-11-12.

The files under `upstream/` are original source snapshots:
- `globals.css` ← `l1-ui/app/globals.css`: complete light/dark OKLCH tokens, normalized accent hues, type sizes, scrollbar, focus and reduced-motion rules; unmodified.
- `viz.tsx` ← `l1-ui/components/ui/viz.tsx`: original Panel, IconTile, Legend and SegmentBar implementations; unmodified and imported directly.
- `button.tsx` ← `l1-ui/components/ui/button.tsx`: original Radix/CVA button implementation; unmodified and imported directly.
- `shell.tsx` ← `l1-ui/components/console/shell.tsx`: reference snapshot, not compiled. Harness navigation adapts its exact class strings and dimensions in app.tsx; product routes/content differ.

The source project's `@/lib/utils` import resolves to a local clsx/tailwind-merge helper with the same behavior. The harness uses React 19.2.4, Lucide 0.563.0 and Tailwind 4.1.18, matching the reference UI. Geist/Geist Mono variable Latin fonts are packaged locally via Fontsource (SIL OFL notices in dist), rather than Next's Google font build fetch. The same seven accent swatches, CSS colour derivation, saved theme key and query-string light/dark support are retained.

Only the UI source was read. The running Chitragupta installation, its services, product gbrain and pinned checkout were not modified. No business API or helpdesk runtime is copied into this harness. There is no dependency on a running Chitragupta server.

The original shared primitives retain their source pixel dimensions. The entire harness page is adapted to its own data and routes; it is not claimed to be a pixel-identical copy of a helpdesk page. Maintain parity by comparing the original source primitives/tokens and rendered theme captures, not by inventing approximate colours.

Rebuild: `node monitor-ui/build.mjs`. Commit dist assets so deployments need no frontend build or dev server. Original source and ownership remain with the reference project; this is internal reuse in the same SSM GitLab group.

The 2026-11-13 operating upgrade follows the original component/theme authority and the owner's requested density. Reference collection `root/ui-reference-images` (45): `eos-v2-21-runs-filtered-grid.jpg` for sticky filters and inline duration bars; `eos-v2-74-dark-deployment-monitoring.jpg` for compact instrumentation; `aps-grid-retail-kpis-column-metrics-light.png` for metric strips and column-local filters. Domain data and foreign palettes were not copied. Supplied before-state screenshots were archived at reference commit `80793b67c79db048c204b2c2d9f1a9e80388373c` and indexed in COMPONENTS.md. Current design behavior is in operations-design.md; README screenshots are rendered from the shipped harness, not mocks.
