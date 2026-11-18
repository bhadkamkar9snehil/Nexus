# Operator and tool reference

[README.md](README.md) is the complete team entry point: installation, screenshots, architecture, startup, credentials, troubleshooting, updates and acceptance limits. [AGENTS.md](AGENTS.md) defines agent behavior. This page contains exact invocation contracts; it is not a second installation guide.

## Connections

Both agents use global `shared_jev`, launched by the installation's Node executable and `jev-use\start.mjs`. Example Codex configuration for a deployment in `D:\Tools\shared-computer-use`:

```toml
[mcp_servers.shared_jev]
command = 'D:\Tools\shared-computer-use\runtime\node.exe'
args = ['D:\Tools\shared-computer-use\jev-use\start.mjs']
```

Claude Code registration:

```powershell
claude mcp add -s user shared_jev -- "D:\Tools\shared-computer-use\runtime\node.exe" "D:\Tools\shared-computer-use\jev-use\start.mjs"
```

Setup also registers `shared_cua` as `runtime\cua-driver.exe mcp --socket \\.\pipe\cua-driver`. Separate stdio adapters are expected; they use the same desktop daemon. Existing entries are preserved, so inspect paths when upgrading. Restart/reconnect agent sessions after changes.

## Invoke without writing a script

```powershell
.\Harness.ps1 tools
.\Harness.ps1 status
.\Harness.ps1 call find_files '{"pattern":"*.pdf","kind":"file","limit":10}'
.\Harness.ps1 call jev_browse '@browser-task.json'
.\Harness.ps1 doctor
```

Inline JSON and `@file.json` both work in PowerShell5.1 (the script passes inline JSON through a temporary file). The CLI calls the same MCP server and emits the same compact monitoring metadata. Shell output is machine-readable; the product UI renders readable views rather than dumping it.

## File names and contents

| Tool | Required | Optional / limits |
|---|---|---|
| find_files | pattern | drive one letter (C default), kind any/file/folder, limit1–100, path_filter directory glob, query for one Jev best-match call over at most24 candidates |
| search_status | none | UFFS state, coverage and memory; no recursive search |
| jev_search_content | root, pattern, query | root existing directory; literal case-insensitive retrieval;24 excerpts of600chars;4MiB files;1MiB output;10s |
| search_local | root, pattern | optional glob, regex, limit1–200 (default50); 15s; local only, includes large files; output excerpts up to600 characters |
| map_files | none | action build/view/root_plan/serve; roots up to5 absolute directories, out_dir, limit_units positive integer, open boolean |

UFFS searches NTFS metadata, not contents. Initial indexing can be slow and memory-intensive; warm queries are much faster. Auto-parking/stopping returns `idle`, not a failure. A status response does not verify a search; run a bounded `find_files` query. Zero current records is not proof that files do not exist. Check coverage/freshness before interpreting absence. The monitor does not warm the index merely to show green status.

Content search skips .env/secrets patterns but is not a comprehensive secret detector. `search_local` does not call TypeSafe; selected excerpts from `jev_search_content` do. Neither performs general PDF/Office/OCR extraction. A truncated result set, timeout, inaccessible file or ripgrep warning is not exhaustive. Local search respects ripgrep ignore rules; use an appropriate scoped root and glob.

## Network investigation

`network_probe` always returns local interfaces. Optional `system` gathers Windows IP configuration, routing table and neighbor cache. Supply `host` for DNS/reverse DNS and optional TCP `ports` (up to100), `ping`, `trace`, or `tls_port`. Supply `url` for a HEAD request with redirects reported but not followed. TLS records peer certificate dates, subject, issuer, negotiated protocol and validation status. `timeout_ms` is100–10000 (default2000).

An explicit IPv4 `subnet` from /24 through /30 triggers bounded ICMP discovery, up to16 probes at once and a maximum timeout of5000ms. No subnet is scanned by default. A timeout or missing ICMP response does not prove a host is absent. Windows tools supply ping, trace and system observations; unavailable commands and errors are returned. This is not a packet capture, UDP scanner, SNMP inventory or a substitute for authenticated device discovery.

map_files produces classification maps, review pages, treemaps and dry-run root proposals. It does not move files. Its serve action starts a separate loopback review endpoint on8766 for explicit review/save interactions. The operating monitor on8769 is read-only. Do not conflate the two.

## Browser tasks

`jev_browse` requires goal, url and expect_text. Optional browser is chrome/edge; backend is cdp/playwright (cdp default); session is a stable alphanumeric/underscore/hyphen name up to40characters; max_steps is1–20. URLs must be HTTP(S) without embedded credentials.

For CDP tasks that generate field text or a written answer, install and start Ollama and run `Setup-LocalText.ps1` once from the Nexus folder. It downloads `qwen2.5:1.5b` and creates `jev-browse\.env` only when no configuration already exists. The configured endpoint is local; Jev decisions still use TypeSafe. Keep Ollama running. Existing text-model environment variables override the file. Local inference can be slow and its answers require review. The Playwright backend fills only caller-supplied `fields` and does not generate answers.

For forms, fields maps exact accessible field labels to caller-supplied text. Example task: goal “Fill Name, check Blue and submit”; fields Name → Harness test; expected text Confirmed. Supported Playwright controls are button, link, checkbox/radio and supplied textbox/searchbox. No general free-text generation or visual fallback is implied.

Chrome/Edge launch automatically. Dedicated profiles preserve sessions without replacing personal profiles. Named Playwright sessions have cross-process locks and reuse browser state. A session_busy result means wait or use an independently intended session, not delete an active lock. After a crash, verify the task is no longer active before removing only its stale lock.

Browser deadline is120s. A step limit, challenge or missing eligible action stops the task. Signed-in persistence requires an actual authorized login test; installed browser state does not prove it. Default-CDP cross-agent calls require serialization.

## Native desktop tasks

`jev_desktop` requires goal, app and expect. Optional: window_id, launch_aumid, text and max_steps1–20. Match exactly one visible app/window. Use a packaged-app launch ID without a window_id, or target an existing window. Native deadline45s.

Calculator example: app Calculator; launch_aumid Microsoft.WindowsCalculator_8wekyb3d8bbwe!App; goal Click Seven; expect Display is 7. Labels depend on the OS language. Text is caller-supplied, not generated by the desktop loop.

The controller selects observed safe accessibility actions. Missing/ambiguous controls stop it; no screenshot coordinate guessing is supplied. Desktop busy protection is per MCP process, so agents must serialize native tasks with each other. Direct Cua batches/scripts are available through shared_cua for predictable supported procedures; they are outside wrapper monitoring unless explicitly instrumented.

## Jev judgments

| Tool | Input | Output meaning |
|---|---|---|
| jev_select_workflow | request; optional context | file_lookup/content_search/browser_task/desktop_task/direct_api or null; no execution |
| jev_rank_results | query;1–24 unique id/text candidates | Best caller ID or null, comparative ranking probabilities |
| jev_classify_failure | operation, observed evidence | Bounded cause category and fixed recovery recommendation; no retry |
| jev_verify_result | request, supplied evidence | satisfied/not_satisfied/uncertain and probability; no independent app observation |

Each makes one API request, sometimes with parallel questions sharing state. Questions cannot see each other's criteria, so fit questions need candidate/category definitions in shared state. Ordinary text up to4000characters; context up to8000; evidence16000; ranking text2000per candidate and IDs80. API timeout8s, no automatic retry.

Fit ≥0.7 permits a recommendation. Verification ≤0.3 returns not_satisfied, ≥0.7 satisfied, between uncertain. These starting thresholds and synthetic tests are not universal accuracy guarantees. Ranking probabilities compare the single best result, not independent relevance. API failures are errors, not negative answers. Check individual outcomes for consequential multi-part requests.

## Monitor controls and state

Monitor.ps1 supports Start, Open, Status, Stop and InstallStartup. Run is the hidden task's internal entry point. Start uses the registered task if present, otherwise a hidden host. InstallStartup preserves another installation's task, migrates this installation's known definition while stopped, and enables restart recovery. Stop is intentional and suppresses recovery for that stop; sign-in startup remains installed until unregistered.

InstallStartup waits up to 60 seconds for the endpoint and verifies the managed flag and running task. If a server is already running outside the task, stop it with Monitor.ps1 Stop and run InstallStartup again. A timeout identifies the endpoint phase and task result; inspect the task history and monitor-error.log. These checks do not exercise search, Jev authentication or a browser task.

Task Scheduler owns the long-running hidden host. The host waits for Node to exit and restarts an unexpected exit after3s, at most999times. The browser-open marker is scoped by boot/logon/session so recovery does not open repeated tabs. Stop terminates both the owned host and server, including the manual fallback, rather than triggering recovery. The machine must be on and the user signed in. No foreground-only terminal session or separate monitor service is required.

The server validates the loopback Host and allows read-only GET routes. Call metadata refreshes every2s; runtime observations are cached30s. Up to500 calls from a256KiB log tail are retained for display. Column filtering/pagination operate on that bounded recorded window, not all historical runs. Internal monitor health polls suppress only their own search-status run events; agent-invoked status calls are still instrumented.

| State | What it proves |
|---|---|
| Monitor online | Local HTTP server responds |
| Healthy desktop | Cua status reports its daemon running; no action executed |
| Browser ready | Supported browser installed; dedicated CDP session observation separate |
| Search idle | Auto-managed daemon stopped/parked; query can start it |
| Jev configured | Credential enrollment detected; no paid API authentication test |
| Agent registered | Global shared_jev entry detected; actual authenticated agent task unverified |

Run KPIs and cost describe recorded responses. Missing/partial usage is labeled. Historical estimate USD0.042 per million input tokens is not billing and excludes other providers. No task text, field values, screenshots or keys are written to wrapper metadata.

## Validation, updates and handover

Use Test-Package.ps1, jev-use unit/reference tests, and monitor-ui/smoke.mjs for affected changes. Run the separate live browser/desktop/decision probes only when task-authorized; they can spend API credit or interact with apps. Setup does not prove fresh-machine acceptance. Record actual behavior, times, limits and relevant errors.

Update the entire README, agent instructions, managed skill, current screenshots and validation evidence together. See README for per-tool key routing, the GitLab release/checksum procedure, rollback and troubleshooting. Synchronize validated source to GitHub Nexus without GitHub Actions. Preserve existing user data and unrelated registrations.
