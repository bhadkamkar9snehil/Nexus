# Tool contracts

Always obtain the current catalog from shared_jev or Harness.ps1 tools; this reference describes the maintained baseline rather than overriding a live schema.

| Tool | Required input | Relevant optional input |
|---|---|---|
| find_files | pattern | drive, kind, limit, path_filter, query |
| search_status | none | none |
| jev_search_content | root, pattern, query | none |
| search_local | root, pattern | glob, regex, limit; local only |
| network_probe | none | host, ports, url, subnet, system, ping, trace, tls_port, timeout_ms; explicit scope for active probes |
| map_files | none | action, roots, out_dir, limit_units, open |
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
