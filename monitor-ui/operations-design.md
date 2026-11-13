# Operating surface contract

User brief2026-11-13: preserve Chitragupta's themes/components; improve monitoring, bounded runs, thin KPI instruments, tools and runtime health; no raw JSON. GitHub deferred. Implementation plan: docs/superpowers/plans/2026-11-13-monitor-operations.md.

Reference collection project45: filtered runs (eos-v2-21), dark deployment monitoring (eos-v2-74), retail column metrics (aps-grid-retail-kpis-column-metrics-light). Inherit filter density, inline duration encoding and metric strips, not their domain data or colours. Supplied before-state screenshots archived at commit80793b67.

Overview uses six compact measured instruments. Activity bars have hourly buckets; pass raster represents finished calls; duration ticks encode actual sample distribution; decision bars show calls; token split shows input/output composition; spend bars compare actual per-tool estimate. No invented budget, trend percentage or targets. Workload composition and duration histogram use the same recorded window.

Runs have a380px maximum internally scrolling body, sticky labels/filter controls, local column predicates, sorting and10/20/50-row pagination. A row opens readable labeled details. Search, filters and sort operate on the bounded server log tail. Unknown values remain missing, not zero.

Capabilities use agent registration rows, category tabs, search, a scrollable list and a readable parameter table with observed call statistics. Health uses separate monitor, startup, desktop, browser, search and Jev panels. Healthy/ready/configured/idle/attention are distinct, not synonymous with end-to-end success.

The browser-open action is once per logon session. Windows Task Scheduler owns the hidden host; that existing host recovers a server exit after three seconds without a separate watcher process. Intentional stop remains stopped. Product UI never displays a wire schema, stack trace or raw JSON; docs may show purposeful invocation/configuration examples.
