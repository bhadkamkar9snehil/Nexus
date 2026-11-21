# Tool contracts

Always obtain the current catalog from shared_jev or Harness.ps1 tools; this reference describes the maintained baseline rather than overriding a live schema.

| Tool | Required input | Relevant optional input |
|---|---|---|
| find_files | pattern | drive, kind, limit, path_filter, query |
| search_status | none | none |
| jev_search_content | root, pattern, query | none |
| search_local | root, pattern | glob, regex, limit; local only |
| start_process | command | shell, cwd, timeout_ms (up to 3000); managed Windows session |
| read_process_output | session_id or pid | absolute line offset, length, timeout_ms; follow next_offset, which revisits an unfinished line; old output may be evicted and oversized lines truncated |
| interact_with_process | session_id or pid, input | append_newline, timeout_ms; queues stdin, does not prove consumption |
| list_sessions | none | cross-client session inventory; no command text |
| force_terminate | session_id or pid | stop managed process tree |
| list_processes | none | pid, name, limit; cumulative CPU seconds and memory bytes |
| kill_process | pid, expected_name, expected_start_time, confirm=true | non-managed process only; use start_identity from list_processes; user authorization required |
| restart_application | pid, expected_name, expected_start_time, confirm=true | user-authorized graceful restart; returns restart id after supervisor is ready; relaunched with the original command-line arguments; the working directory is not restored |
| restart_status | id | inspect the persisted restart outcome after reconnecting |
| network_probe | none | host, ports, url, subnet, system, ping, trace, tls_port, timeout_ms; explicit scope for active probes |
| map_files | none | action, roots, out_dir, limit_units, open |
| web_scrape | url | format, max_chars, browser_session, browser |
| browser_read_page | session | browser, format, max_chars, offset_chars, expected_sha256; use next_offset_chars and hash guard for pagination |
| jev_browse | goal, url, expect_text | browser, backend, session, fields, max_steps |
| jev_desktop | goal, app, expect | launch_aumid, window_id, text, max_steps |
| jev_select_workflow | request | context |
| jev_rank_results | query, candidates (id/text pairs) | none |
| jev_classify_failure | operation, evidence | none |
| jev_verify_result | request, evidence | none |

For browser forms, fields maps exact accessible names to caller-supplied values. Do not put credentials into descriptions or monitor metadata. Use dedicated profiles; persistent authentication requires a separate actual login test.

Native example: goal Click Seven, app Calculator, launch_aumid Microsoft.WindowsCalculator_8wekyb3d8bbwe!App, expect Display is 7. Titles and accessible values depend on OS language.

Limits: 1–20 browser/native steps; browser deadline120s, native45s. Ranking up to24 candidates. Search excerpts are bounded and do not prove exhaustive coverage. Jev semantic verification returns satisfied/not_satisfied/uncertain based only on supplied evidence.

Humans can save arguments as a JSON file and invoke `Harness.ps1 call -Tool <tool> -Arguments '@arguments.json'`. Quote the @filename in PowerShell5.1. The shell fallback uses the same MCP implementation and instrumentation, not a second automation service.

Canonical guide: http://10.2.6.112:8080/ssm/shared-computer-use. On another network use the repository's configured Tailscale remote. The public source snapshot is https://github.com/bhadkamkar9snehil/Nexus; GitLab remains the development and CI upstream.
