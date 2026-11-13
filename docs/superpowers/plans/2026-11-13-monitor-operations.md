# Monitor operations upgrade

Approved scope: user request 2026-11-13, existing Chitragupta design language, GitLab only (GitHub deferred by owner).

1. Keep a single monitor task alive, recover failed server exits, and open the UI once per sign-in. Preserve an intentional stop and prevent duplicate server/browser launches. Test actual task restart, readiness and browser-open suppression.
2. Add read-only cached runtime observations for monitor/startup, Cua, browser installation/session, UFFS/broker, Jev enrollment and MCP registrations. Distinguish configured, idle, healthy, unknown and failed; never infer working from a key file alone.
3. Rework overview around thin source-token KPI instruments, outcome composition, latency distribution and tool workload. Recent runs: sticky column filters, internal scroll, pagination, stable row selection and formatted details. All numbers come from recorded metadata.
4. Replace raw tool schemas with grouped searchable capabilities, readable parameter tables and observed usage. Replace raw health JSON with named component states, measured values and actionable next steps. Keep raw wire data out of every product page.
5. Rewrite README and onboarding end-to-end; package a focused skill and installer. Capture current light/dark overview, tools and health screenshots. Use relative image links that work on GitLab/GitHub. Archive supplied references in the approved GitLab collection.
6. Verify UI interactions, responsive/theme states, failure/disconnect cases, lifecycle recovery, TypeScript and reference tests. Push MR, wait for Windows CI, merge and publish a verified deployment ZIP and checksums. Record current guidance in GBrain, retiring superseded deployment facts.

Reference evidence: root/ui-reference-images project45: eos-v2-21-runs-filtered-grid.jpg, eos-v2-74-dark-deployment-monitoring.jpg, aps-grid-retail-kpis-column-metrics-light.png. These guide layout and data density, not a palette replacement.
