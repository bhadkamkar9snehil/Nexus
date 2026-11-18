---
name: shared-harness
description: Use the installed shared Windows harness for browser tasks, native desktop interaction, fast file and folder discovery, file-content search, and bounded Jev decisions. Use when shared_jev tools are available or when setting up this harness; prefer existing APIs for known deterministic operations.
---

# Shared harness

Use the installed tools for supported capabilities. Do not write one-off scripts or use direct libraries to duplicate harness tools, including for tests and troubleshooting; report a tool failure rather than silently substituting another implementation. Read [tool contracts](references/tools.md) for inputs and stopping conditions.

## Route the task

- Names, folders, metadata: `find_files` through UFFS. Do not replace it with recursive PowerShell enumeration. If unavailable, inspect `search_status`; report the actual limitation.
- Text in known folders: use `search_local` for local-only search, large files and sensitive content; use `jev_search_content` when bounded excerpts may be sent to Jev for ranking. Inspect truncation and errors; neither extracts PDF/Office content.
- Network investigation: `network_probe` inspects local interfaces and optionally probes explicitly supplied hosts, URLs or IPv4 subnets. A missing ICMP reply is not proof a host is absent. Choose the target scope deliberately.
- Websites: `jev_browse`; it launches Chrome/Edge itself. Prefer `backend=playwright` and a stable session when cross-agent browser contention matters.
- Native Windows controls: `jev_desktop`; use an exact app/window and explicit expected result. Packaged apps can use launch_aumid.
- Uncertain route, candidates, errors or supplied outcome evidence: `jev_select_workflow`, `jev_rank_results`, `jev_classify_failure`, `jev_verify_result`. Recommendations do not execute themselves; uncertain/null is a valid result.
- File organization proposals: `map_files`; inspect its current schema. It builds maps and dry-run proposals, not file moves.

Use a known API or saved deterministic procedure when it is sufficient. Jev is for judgments; code executes bounded valid choices. Keep task arguments and transmitted evidence necessary and nonsecret.

## Shared resources

Both agents use `shared_jev`; `shared_cua` connects to the same Cua named pipe. Do not start another driver, index, browser per call or personal browser profile. Serialize desktop and legacy-CDP requests across agents. Named Playwright sessions reject concurrent ownership with session_busy; never delete a lock without checking its owner.

The monitor is http://127.0.0.1:8769/. Its connection indicator proves only that the monitor responds. Component health distinguishes running, installed, configured, idle and unverified. A stopped UFFS daemon can be normal on-demand idleness; use a bounded find_files query to verify search.

## Verify and stop

Supply a terminal expected state. Read the returned status and fresh app evidence before claiming success. A completed call, registered MCP entry, existing key or Jev evidence judgment alone does not prove the actual application outcome. Stop on unknown controls, authentication challenges, limits or ambiguous targets; do not silently substitute coordinate guesses.

## Setup or repair

Find the existing installation and read its AGENTS.md and README.md before changing it. Keep it outside AppData. Setup.ps1 verifies the deployment, enrolls a local DPAPI key when requested, preserves existing MCP registrations and installs one managed monitor sign-in task. Optional tool-specific key aliases and mappings are documented in README.md and stay in the ignored local secrets folder. Reconnect agents afterward. Never print a key or put credentials, browser sessions or run history in source or handovers.

Before any task, confirm `shared_jev` tools are listed and `search_status` succeeds; if not, the MCP is not connected: run the installation's `Harness.ps1 doctor`, read the startup cause it prints, repair, reconnect, and report. `Harness.ps1 tools/status/call <tool> '<json>'` (inline JSON or `@file.json`) is a diagnostic that starts its own server and does not prove the agent's MCP session is connected. Start/open/stop the monitor with Monitor.ps1. Preserve another installation's task or registration and report the conflict before migration.
