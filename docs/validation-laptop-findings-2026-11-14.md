# Laptop validation findings — 2026-11-14

Status: investigation required; no fixes are included. The tested installation came from the documented GitHub mirror; equivalence with GitLab main was not verified.

## UFFS drive coverage

On a Windows laptop with fixed NTFS C: and D: volumes, search_status reported only C: indexed. A find_files search for Harness.ps1 on D: returned status done with no matches, although the harness checkout contained that file on D:. A search of a synthetic file on C: succeeded. Confirm index coverage and freshness, investigate why D: was missing, and ensure callers cannot mistake an uncovered drive for a verified absence. HDD media can affect indexing time; it does not establish the cause.

## Browser completion

Playwright tasks against a public example page and the local monitor abstained before taking action. In a CDP task the harness clicked the intended link but continued until the step budget was exhausted instead of recognizing completion. Both packaged synthetic form probes passed, one each with Playwright and CDP. Reproduce against controlled fixtures and distinguish an actual completion-detection failure from unsuitable expected text or a normal abstention.

## Direct Cua accessibility

The bundled direct Cua diagnostic captured the Calculator window but reported an empty accessibility tree; run_steps stopped at the first Clear action. A separate jev_desktop test reported a verified Seven action. Investigate the window/hosting and UIA conditions; do not infer a general driver failure from this single window.

## Setup and runtime observations

- Source setup in PowerShell stopped while checking a missing Codex MCP registration: stderr from codex mcp get became a terminating NativeCommandError under ErrorActionPreference Stop. Manual registration succeeded. Reproduce with no existing registration and preserve existing entries.
- An already-running MCP process reported a missing API key after enrollment, while a fresh CLI process authenticated successfully. Reconnecting after enrollment is documented; investigate whether diagnostics can surface the stale process state clearly.
- Monitor status reported ready, while a network_probe HEAD request to its root returned 403. Confirm intended method and Host validation behavior before treating it as a defect.
- Release asset links pointed to an office-only address when GitLab was reached over Tailscale. Validate an accessible release download path.

## Acceptance

Add focused regression coverage for confirmed defects, report drive coverage explicitly, and repeat bounded browser and desktop probes on a clean Windows setup. Do not claim fixes or broad end-to-end reliability based on these observations alone. No credentials or private addresses are included.
