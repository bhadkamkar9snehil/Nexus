# Validation and acceptance

## Unattended installer diagnostics and verified monitor receipt — 2026-11-21

**Issue #60 increment:** The previous silent updater returned success when Inno Setup returned zero and the installed version matched, even if the monitor task was missing or port 8769 belonged to the wrong installation. A separate interactive install once returned exit code 7 without an Inno logfile. The updater now passes Inno Setup `/LOG` on every unattended install attempt, records its path in `%LOCALAPPDATA%\\Nexus\\auto-update.log`, and saves `%LOCALAPPDATA%\\Nexus\\last-install-receipt.json` with the target version, exit code, monitor verification state and diagnostic path. It requires a running `SharedHarness-Monitor` task and a responding, managed monitor whose root matches the registered installation before it returns success. It retries monitor health for a bounded period after setup.

**Failure tests:** A simulated installer error keeps its nonzero exit, a stale registered version fails, a missing task fails, a healthy monitor under another root fails, and a healthy matching monitor passes. These tests mock Windows setup and never alter the installed Nexus. The focused Windows/Node22 suite passed 12/12. The published v1.18.2 installer and original user files are unchanged by this development-branch test. This change is diagnostic and verification hardening; Dhaval's target-machine acceptance still requires its own receipt.

## v1.18.2 installed-layout package hotfix — 2026-11-21

The published v1.18.1 installer returned nonzero on a live v1.18.0 upgrade. It copied files, but setup failed in `Test-Package.ps1`: the check tried to parse `installer/Preflight.ps1`, although the install payload intentionally excludes the `installer` source directory. The v1.18.1 registry version was present while the monitor task and HTTP endpoint were absent. The revised check skips this one source-only script when it is not shipped, but continues to parse it in development/CI when it exists. The GitLab release job now also triggers for changes to `Test-Package.ps1`.

**Actual installed-layout acceptance:** A temporary copy of the corrected package checker was executed inside the installed Nexus v1.18.1 directory, without an `installer` subdirectory: TypeScript, monitor syntax and MCP catalog all passed. The actual installed `Setup.ps1 -NoBrowserAtSignIn` was then run with that corrected checker. It returned code 0 in 69.97 seconds, recreated `SharedHarness-Monitor`, and verified an HTTP-responding managed monitor at the installed root. Optional agent/skill duplicate-registration warnings did not abort setup. The temporary checker was removed and the original restored. This tests the exact previously failing setup path, not just a source worktree.

The v1.18.2 installer still requires publication and a new clean in-place upgrade receipt; user-specific Windows policy and unrelated process ownership cannot always be repaired automatically.

## Installer failure-path patch acceptance — 2026-11-21

The urgent patch includes the existing v1.18.0 takeover helper and fixes three observed updater failures: private GitLab access dependency, false installer success, and first-host curl failure aborting fallback. It also retries the monitor takeover once, preserves the detailed error, and gives interactive recovery steps. Inno Setup's `GetCustomSetupExitCode` now reports a nonzero status when post-copy setup fails. The **actual Inno Setup compiler** successfully built a minimal v1.18.1 fixture using these installer scripts. A separate Windows fixture proved both actionable preflight failure and successful continuation, without terminating live processes. `Test-Package.ps1` parses the updater and preflight scripts on every CI validation. A complete real-machine upgrade is still required; none of these checks proves that all environmental failures can be repaired without user action.

## Nexus v1.18.0 post-release updater defects — 2026-11-21

GitHub v1.18.0 is published with a Windows installer, SHA-256 digest and matching source files. Publication is not proof of installation on Dhaval's or Mahesh's computer. The connected desktop reports installed v1.17.1 with a running Nexus monitor and a saved GitLab token. The installed updater's read-only check discovered v1.18.0 and returned `action=install, reason=quiet moment`. No in-place upgrade success was observed.

**Issue #60 patch, branch `fix/nexus-auto-update-60` (not released):** The v1.18.0 updater logs installer exit code 5 but exits 0 from its one-off scheduled task. The patch propagates the actual installer exit code, fails on launch errors, and checks the registered installed version after exit code 0. The existing v1.18.0 worker also depends on private GitLab release access; the patch prefers a public GitHub release with matching SHA-256 in release notes and asset digest, and uses GitLab as a fallback. Public download paths must match the exact Nexus GitHub repository, version and filename. The updater never sends a GitLab token to GitHub.

Tests simulate failed/successful installer processes and stale registered versions without running any installer. Tests also cover GitHub release metadata without a private token and mismatched digests. A live **read-only** query to GitHub's public releases API, with no GitLab token, selected v1.18.0 correctly. A later real update attempt from the installed v1.17.1 copy failed before installation: `curl.exe` could not connect to the first Tailscale GitLab host (`100.110.236.122:8080`). Under Windows PowerShell with `ErrorActionPreference=Stop`, curl stderr raised a terminating `NativeCommandError`, so the updater never tried the second host. The patch uses `Invoke-NexusCurl` to handle native exit codes without a PowerShell abort and bounds host connection timeouts. A targeted test exercises a failing first curl address followed by a successful second source. On Windows with Node 22.22.0, `Test-Package.ps1` and **213/213 headless tests passed**. The real attempt stopped before the installer ran; the installed copy remained v1.17.1. This patch still needs new branch CI, review, a patch release and actual in-place machine acceptance.

## Nexus browser, plugin and CI branch validation — 2026-11-21

Development source: GitLab feature branch `feat/nexus-tool-registry-49`; no merge to `main` and no release. The branch contains the typed tool registry, browser read-only extraction, HTTP-first scraping, plugin capability contracts, the optional Firecrawl v2 adapter, and branch-only CI. Neither Firecrawl nor any plugin is installed or enabled by these commits.

Tested locally from the feature worktree on Windows with verified Node v22.22.0, matching the CI runtime version. Before the compatibility fixes, the headless suite had 200 passing tests, two event-subscription failures caused by a transient Windows `EPERM` rename, and one cancelled plugin timeout test. Event subscription reads and atomic replacement now retry bounded transient file locks; the plugin timeout uses a referenced timer with cleanup. After the fixes, all 203 of 203 headless tests passed and `Test-Package.ps1` passed. The unrelated interactive application-restart test remains a separate pre-release requirement.

The B19CL3PC feature-branch pipeline for `e4472fc` reported success on 2026-11-21. It ran for 4 minutes 57 seconds according to Nexus webhook timestamps. GitLab job traces and preview artifacts could not be inspected without authentication, so installer integrity was not independently confirmed. The GitHub repository updates only after the approved GitLab `main` release, not feature previews. No installed device was changed.

**CI controls in the next feature commit:** Superseded branch jobs can be cancelled. The `main` release job cannot. Local `CI-Validate.ps1` completed on verified Node v22.22.0 in **77.25 seconds**: npm restore 19.50 seconds, `Test-Package.ps1` 28.62 seconds, and 203 headless tests 29.06 seconds. It produced JUnit XML and a JSON phase report with zero failures. The new `CI-Preview.ps1` checks source ZIP structure and both package SHA-256 hashes and records elapsed time. Branch CI must still verify these scripts on B19CL3PC before their timing or report delivery is accepted. After adding a pipeline-duration summary regression test, the complete Node 22 headless suite passed **204/204**, and `Test-Package.ps1` passed again. CI soft targets are 120 seconds for validation and 480 seconds for preview packaging; the jobs emit warnings rather than fail for target overruns. The GUI restart test remains outside headless CI and is a release gate.

## Browser read-only acceptance probes — 2026-11-21

Tested the feature-branch `browser_read_page` directly with Node v22.22.0 and an existing Playwright Chrome session. A JavaScript-generated fixture returned rendered Markdown, a table, the page language, retrieval time, and stable content hashes across 100-character pages. Sensitive synthetic URL query values were redacted. A stale `expected_sha256` returned `content_changed`; the browser page retained its original JavaScript state after reads. A separate local HTTP fixture used an HttpOnly authorization cookie and a redirect to a protected page. Nexus read the protected page from the existing authorized session, retained code/list content, and did not expose the cookie in the result. Both fixture browser sessions and the temporary server were closed after testing. A third fixture with no title and a form returned visible content but not form values; a post-read browser check confirmed the form remained present and unsubmitted (`forms=1`, `submitted=0`). That session was also closed.

The tests exercise read-only extraction only. A separate positive smoke test called `browser_read_page` through the full `cli.mjs` and shared MCP server using Node v22.22.0. It returned `# Tool path live` from an existing Chrome session with exit code 0 in about 3.1 seconds. The new branch validation also tests a deterministic missing-session response through the same MCP path. The complete revised `CI-Validate.ps1` passed locally with 206/206 Node 22 tests. Phase times were npm restore 19.03 seconds, package checks 28.97 seconds, actual MCP tool call 4.56 seconds, and headless tests 28.94 seconds, for 81.56 seconds total. These tests do not prove browser behavior on arbitrary third-party login systems. The full headless suite includes pagination, input validation, session-not-found, and lock-contention checks. The GUI restart acceptance remains separate.

## Local browser text — 2026-11-18

On the owner's Windows laptop, `Setup-LocalText.ps1` configured an existing Ollama installation with `qwen2.5:1.5b`. The CDP browser filled a local fixture with the requested text and returned an answer from a public example page. A small local model initially misclassified requested answers during review; the local path now asks Jev separately whether the answer is supported and complete and rejects low-confidence or invalid results. These are bounded probes, not proof that every page or answer is correct. The Ollama installation itself and the setup on a clean teammate machine have not been verified.

## Dhaval installer upgrade: monitor takeover — 2026-11-21

Dhaval's Nexus Harness **v1.17.1** screenshot shows that Inno Setup stops before file copy because another installation owns `SharedHarness-Monitor`. The previous `installer/Preflight.ps1` deliberately rejects a different monitor folder. The feature-branch fix adds `Nexus-Takeover.ps1` to the installer and payload. Inno extracts it before copying, and `Setup.ps1` uses the same helper when repairing manually. It verifies current-user task ownership, a known Nexus monitor process and exact Nexus executable/script paths. It backs up the prior scheduled task XML under `%LOCALAPPDATA%\Nexus\installer-migrations`, removes the old monitor task, stops recognized Nexus desktop, monitor and MCP processes, waits for port 8769 to become free, and then continues setup. It never stops generic Node, PowerShell or another process that merely listens on port 8769. Prior installation folders and user data are not deleted.

Safety tests dot-source the helper's pure process/task-identity functions without stopping anything. A read-only live Windows check exposed two ownership differences: `Win32_Process.GetOwner()` returns `User`, not `UserName`; Windows Task Scheduler can store an unqualified username (`Admin`) rather than `DOMAIN\Admin`. The helper now uses the correct CIM field and resolves the task principal to the current user's SID. Read-only probes confirmed the owner, monitor PID and exact running `monitor.mjs` path on the connected desktop. Windows PowerShell syntax parsing, `Test-Package.ps1`, the headless unit suite and a preview installer build must pass before accepting the change. **Dhaval's computer is not connected to Desktop Commander**, so the specific in-place upgrade has not yet been tested on his machine. A feature-branch preview is not a production release; GitLab main and automatic updates remain unchanged.

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
