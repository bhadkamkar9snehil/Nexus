# Shared harness — start here

This is one Windows-native automation package shared by Codex and Claude. Read [README.md](README.md) for installation, architecture, operation and limits; use [USAGE.md](USAGE.md) for exact tool contracts. The packaged [shared-harness skill](skills/shared-harness/SKILL.md) is the portable agent entry point. CLAUDE.md imports this file.

## Work through the installed tools

1. Reuse `shared_jev`. `shared_cua` is a direct adapter to the same Cua named pipe, not another desktop service. Do not create another driver, browser per request, index or automation engine. Do not write one-off scripts or use direct libraries to duplicate harness tools, including for tests and troubleshooting; report a tool failure rather than silently substituting another implementation.
2. File/folder names and metadata: `find_files` through UFFS. Contents: `search_local` for local-only or large-file search; `jev_search_content` for bounded Jev ranking when sending excerpts is appropriate; scoped ripgrep remains available. Check truncation and errors. No recursive PowerShell discovery or silent slow fallback. If unavailable, inspect `search_status` and report coverage/readiness accurately. Exact-path administration may use PowerShell.
3. Websites: `jev_browse` launches Chrome/Edge automatically. Use named Playwright sessions for related requests and contention protection; session_busy is a valid response. Native Windows: `jev_desktop` with exact app/window and expected state. Serialize desktop and legacy-CDP calls across agents.
4. Use known APIs or deterministic procedures when sufficient. Use `network_probe` for scoped local network and endpoint observations. Use Jev for uncertain actions, workflow selection, candidate ranking, failure classification and evidence judgments. Honor null/uncertain responses; a recommendation does not execute or authorize itself.
5. `map_files` creates maps, review pages and dry-run proposals. Do not treat it as permission to move files. Inspect current schemas and caller authorization before any separate data-changing operation.
6. Supply explicit end conditions and read fresh app evidence. Configured credentials, registered MCP entries, installed components, a completed tool call and semantic evidence judgments each prove only their own layer.
7. If MCP is disconnected, use the installed `Harness.ps1 tools/status/call` or `jev-use/cli.mjs` with quoted `'@arguments.json'`. Do not replace a standard interaction with a new one-off engine.

## Install and operate

- Windows11 x64 and PowerShell5.1. No Docker/WSL/VM/local inference or Python environment required. Keep installation outside AppData to avoid packaged-app virtualization.
- Setup validates runtime hashes, preserves existing MCP entries, enrolls credentials when requested, installs missing managed skills and configures one `SharedHarness-Monitor` sign-in task. Reconnect agents afterward. Existing unrelated tasks, registrations and skills must survive.
- `Monitor.ps1 Start/Open/Status/Stop/InstallStartup` manages the UI. The task owns a hidden long-running host, which restarts an unexpected server exit after three seconds. Stop intentionally respects the user; do not restart it behind their back. Sign-in opens the default browser once per logon session, not once per recovery.
- Port8769 is loopback only. The monitor is read-only and is not a remote execution endpoint. Reachability proves the monitor responds; runtime health separately shows observed component states. Idle UFFS and untested Jev authentication must not become false failures or false success claims. A bounded find_files query verifies search separately.
- The default key alias is computeruse_1. Optional per-tool aliases and their mappings stay in the ignored local secrets folder; encrypt keys with Windows DPAPI. Never print or commit keys, credentials, personal browser profiles, sessions or run history. Send only task-authorized necessary state to TypeSafe.

## Change and ship

- Preserve dirty work; no subagents or delegated work. Keep the solution small and reuse existing executors/components.
- UI authority is [DESIGN.md](DESIGN.md) and [provenance](monitor-ui/PROVENANCE.md). Improve flows within the original Chitragupta components, palette and themes. No raw JSON/schema/stack-trace dumps in any product view. Translate observations into labeled states, metrics and useful actions.
- Build static UI with `node monitor-ui/build.mjs`. Test actual rendered controls, desktop/mobile, light/dark, loading/empty/error/disconnect states, column filters, pagination and details. Monitor status is never a substitute for testing the relevant business action.
- Run Test-Package.ps1 and the jev-use reference/unit suite before committing. Windows CI restores dependencies using Test-CI.ps1. Do not run npm ci over binaries held by active local agents; use an isolated stage or stop the relevant owner first.
- **Rewrite the entire README coherently when behavior changes.** Update USAGE.md, this file, the packaged skill, current screenshots and validation evidence at the same time. Replace obsolete guidance instead of adding contradictory appendices. Keep README image links relative so the same source works on GitLab and GitHub.
- New screenshots go under docs/screenshots and must show the shipped UI without private task content or credentials. Reference screenshots belong to the approved GitLab collection. Archive owner-supplied references there; document which patterns were reused.
- Upstream is self-hosted GitLab `ssm/shared-computer-use` (project55), office origin/Tailscale remotes. Branch → MR → observed green Windows pipeline → merge → annotated release tag and verified deployment ZIP/checksum. Push authorized work; never claim unseen CI or package acceptance.
- Keep GitHub `bhadkamkar9snehil/Nexus` synchronized with validated GitLab source and relative README screenshots. GitLab runs CI; no GitHub Actions.
- Build/release from the merged source; verify extraction using bundled Node and confirm registry SHA256. Existing deployed paths and per-user data require deliberate migration, not broad overwrite. Record limitations and rollback instructions.
- Durable findings go to the agents' GBrain with evidence; never touch Chitragupta's product gbrain. Retire superseded current guidance while retaining labeled historical evidence.
