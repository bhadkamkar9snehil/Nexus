# Validation and acceptance

## Local browser text — 2026-11-18

On the owner's Windows laptop, `Setup-LocalText.ps1` configured an existing Ollama installation with `qwen2.5:1.5b`. The CDP browser filled a local fixture with the requested text and returned an answer from a public example page. A small local model initially misclassified requested answers during review; the local path now asks Jev separately whether the answer is supported and complete and rejects low-confidence or invalid results. These are bounded probes, not proof that every page or answer is correct. The Ollama installation itself and the setup on a clean teammate machine have not been verified.

## Desktop installer assembly

Publishing the WPF project directly into its source staging directory's parent can produce an assembly containing only the generated application class: the executable runs without opening a window. `Publish-Desktop.ps1` publishes outside the source tree, validates the assembly's `App.OnStartup`, `MainWindow` and `SettingsWindow` metadata, and validates the copied installer payload again. The desktop CI job exercises the same script. This static check does not replace a Windows UI launch or fresh installer acceptance test.

For MR !30, pipeline 431's desktop-build job passed. Its validate job 914 failed the existing Windows loopback ping-discovery test with a timeout on AUTOSRV02; 124 of 125 tests passed there, and all 125 passed locally. The runner timeout remains uninvestigated.

## Current operating upgrade — 2026-11-13

Tested on the owner's Windows11 x64 laptop. This is not clean teammate-machine acceptance.

| Check | Observed result |
|---|---|
| PowerShell5.1 managed start | Hidden long-running task host starts the HTTP server |
| Duplicate launch | Start reuses the current PID |
| Intentional stop | Owned host/server stop without immediate recovery |
| Unexpected server exit | Controlled process kill recovered in5.1s; repeated twice |
| Browser launch suppression | Per-logon marker unchanged across recovery |
| Task ownership | SharedHarness-Monitor remains Running while the host waits for Node |
| UI desktop/mobile |1600×1100 and390×844, no horizontal document overflow |
| Themes | Light/dark, accent change and collapsed/expanded navigation passed |
| Recent runs | Internal scroll, sticky filters, sorting controls,10/20/50 pagination and readable details |
| Filter checks | Status, duration, text and clear/reset tested; per-column controls present |
| Capabilities | Current ten-tool catalog, categories/search and readable parameter table |
| Runtime health | Six named component panels; no raw JSON; idle search and unverified provider states distinct |
| Disconnect | Injected runs503 displayed reconnect state; restored connection recovered |
| HTTP boundary | POST403 and unknown asset404; loopback Host validation retained |
| No raw product panels | No preformatted JSON/schema dump on overview, tool, health or usage views |
| Reference/unit suite |114 tests passed; includes latency percentile interpolation test |
| Server/UI TypeScript | Passed |
| PowerShell parser | Monitor, runtime inspector, skill installer and Setup passed |
| Skill validation | Official quick_validate.py passed; installed for both local agents |
| Mechanical UI detector | No findings |

Screenshots in docs/screenshots are actual rendered captures and are linked from README with relative URLs. They contain recorded tool metadata only. The browser plugin was unavailable; installed Playwright/Chrome performed rendered QA. Supplied before-state references are archived and indexed in GitLab root/ui-reference-images.

### Recovery finding and correction

The original monitor was absent after an overnight reboot because it had only a foreground launch and no sign-in task. The first source fix added sign-in startup. In this upgrade a controlled crash showed that Task Scheduler's configured failure retry alone did not recover within90s. That setting is not treated as proof of recovery.

The verified implementation uses the existing hidden PowerShell host to wait for Node to exit, then restart after3s, up to999 exits. No extra watcher process was added. Stop terminates the owned host/server. Task Scheduler owns the host at sign-in; the default browser opens once per boot/logon/session marker, not after every server recovery. Two controlled server kills each recovered in5.1s. No actual reboot or crash of the host itself was performed; availability remains bounded by Windows, user sign-in and the retry limit.

### Observability scope

The monitor reads a256KiB metadata tail, up to500 calls. UI polls calls every2s; read-only component observations are cached30s. Internal health status probes suppress their own agent-run events. Explicit agent status calls are still recorded. Earlier events that came from the old monitor cannot be retroactively identified and are retained rather than guessed away.

Health distinguishes server reachability, managed startup, Cua daemon status, installed browsers/dedicated CDP observations, UFFS/broker state, Jev credential enrollment and global MCP registration. It does not perform a paid Jev request, UI action or authenticated agent task. Unknown measurements are not reported as zero. The usage estimate is not a billing statement.

## Established executor baseline

These results are historical and were not rerun merely for a UI change:

| Synthetic Jev decision fixture (2026-11-12) | Result | MCP elapsed | API requests |
|---|---|---:|---:|
| Folder-name request → file_lookup | Pass |706ms|1|
| Invoice excerpt over photo | Pass |389ms|1|
| Expired-session401 classification | Pass |270ms|1|
| Calculator2+2 evidence accepted | Pass |334ms|1|
| Login screen does not prove saved invoice | not_satisfied |343ms|1|

Model was jev-1.14.0. Initial missing shared candidate/category context was fixed and regression-tested. Exact model probabilities are not asserted. Browser form actions, Chrome/Edge auto-launch, Calculator action and named Playwright warm reuse passed in earlier probes; see the corresponding GBrain records. They do not prove sign-in persistence or arbitrary app capability.

## Release acceptance

For each deployment: build from the merged source, verify extraction using bundled Node without global Node/npm, verify required assets/skills/guides and runtime hashes, exclude private state, upload ZIP/checksum, then compare the registry SHA256/size. The GitLab pipeline and release records are authoritative for publication status; do not infer them from a local file.

## Source setup reliability — 2026-11-13

An isolated source worktree restored its dependencies in staging, completed the package check, and then reused its recorded lockfile on a second install. The Windows install-safety test checks that unverified existing dependencies are preserved and that a matching lock is reused. The active installation and its monitor task were not replaced. This does not establish a fresh-machine or post-reboot acceptance result; a release ZIP must still be built and verified from merged source.

The owner authorized GitHub Nexus publication on 13 November 2026. GitLab remains the development and CI upstream; README screenshots use relative links on both hosts.

## Remaining boundaries

- Clean-machine installation/elevation, user-specific permissions, real authenticated Codex/Claude task invocation and lab-app signed-in persistence need destination acceptance.
- Native/legacy-CDP cross-agent arbitration is incomplete; serialize those requests. Playwright named-session locks provide a separate bounded contention check.
- Desktop controller requires usable accessibility controls. No integrated visual fallback or general plan/recovery executor is shipped.
- Jev outcome checking judges supplied evidence; it does not independently inspect an application.
- UFFS metadata and bounded text retrieval are not exhaustive content search or PDF/Office/OCR extraction.
- Source changes were validated without upgrading third-party engines. Playwright CLI's pinned alpha dependency remains disclosed.

## Terminal and process tools — 2026-11-20

An isolated source worktree reproduced a paging defect where a line completed after a partial read was skipped by the returned cursor. The focused regression failed before the correction and passed afterward. On the laptop, the full suite passed 135 tests and Test-Package.ps1 passed after the correction. Windows runner validation and release remain pending. Oversized individual lines are truncated and cannot be paged by character offset.

The output-cap test later reproduced a dead worker with its last state still marked running. Temporary diagnostics captured a Windows `EPERM` on atomic state-file replacement during concurrent reads. The worker now retries transient sharing failures for up to two seconds for state and output replacement; ten focused concurrent-read runs passed locally. The diagnostic output was removed; Windows CI and installed-runtime acceptance remain separate checks.

External process termination now requires the start identity observed in `list_processes` and verifies it with the image name using the same Windows handle used to terminate. A synthetic child with a deliberately stale identity was previously terminated; the regression now rejects it, including a direct check of the handle-level guard. A matching synthetic child can still be terminated. Managed-session process-tree and client acceptance require separate checks.

The desktop catalog was tested in an isolated loopback monitor: all seven Terminal tools and the required termination identity were visible, session data contained only the documented metadata, and the rendered smoke checks passed at desktop and mobile sizes in light and dark themes. The session panel reports registry state, which can be stale after an unexpected worker exit. The monitor remains read-only and does not execute the tools.

The Nexus terminal batch adds seven managed MCP tools to the Windows source checkout. The full local regression suite passed 134 of 134 tests. `Test-Package.ps1` passed source TypeScript checks, monitor and terminal-worker syntax, PowerShell parsing, and MCP tool discovery. Focused Windows checks covered output paging and eviction, interactive input, CMD, PID-name validation, managed session termination, and a session that remained accessible after the original MCP client disconnected. These checks used separate test directories and did not replace the installed Nexus application.

The implementation uses detached per-session workers with retained output. It does not provide a PTY or an operating-system sandbox. Windows credentials and permissions remain those of the logged-in user. GitLab CI, release package extraction, and installation on a separate machine require independent verification. Existing monitor screenshots are unchanged because the new source has not been deployed.
