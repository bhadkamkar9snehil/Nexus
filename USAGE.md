# Operator and tool reference

For an extracted deployment ZIP, run `Nexus.Setup.exe repair "<installation directory>"` from Windows. The same compiled helper handles wizard installation and desktop repair. **Updates → Update now** shows the download and checksum check, then opens the Setup wizard. If Task Scheduler denies takeover, the wizard offers **Run as administrator** for that step. Setup diagnostics are written to `%LOCALAPPDATA%\Nexus\setup.log` and manual update installer output to `%LOCALAPPDATA%\Nexus\manual-update.log`.


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

## Protocol and events

`shared_jev` is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and `/client` 2.4.0) and entered through `serveStdio`, so one server speaks both the 2026-07-28 protocol revision (`server/discover`, per-request capabilities) and the 2025-era `initialize` handshake. The host picks the era; nothing in Nexus depends on which.

Nexus implements the MCP **Events** extension (`io.modelcontextprotocol/events`, beta, SEP-3415) with all three delivery modes. Every event type lists `delivery: ["poll", "push", "webhook"]`.

- **Poll** (`events/list`, `events/poll`): the spec's `{eventId, name, timestamp, data}` occurrences, opaque cursors (`null` starts from now), `maxEvents`/`hasMore`, `maxAgeMs`/`truncated`, `nextPollMs`.
- **Push** (`events/stream`): a long-lived request on the stdio connection. The server sends `notifications/events/active` (cursor, `truncated`, granted `heartbeatMs`, clamped to 1-60 s, default 30 s), then `notifications/events/event` for each occurrence and `notifications/events/heartbeat` (carrying the cursor) while idle, every message tagged with the request id as `io.modelcontextprotocol/subscriptionId`. Cancelling the request (`notifications/cancelled`) ends it; a retention gap sends a fresh `active` with `truncated: true`.
- **Webhook** (`events/subscribe`, `events/unsubscribe`): the client supplies an https `delivery.url` and a `whsec_` secret (`whsec_` plus base64 of 24-64 random bytes) and refreshes before `refreshBefore` (default grant 1 hour, minimum 1 minute, `ttlMs: null` requests no expiry; no-expiry subscriptions are stored on disk and survive restarts). Deliveries are signed per Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,...`, plus `X-MCP-Subscription-Id`), the body carries a safe-to-persist watermark `cursor`, a failing endpoint is retried with the same `webhook-id` (up to 4 attempts over at most 10 minutes, then abandoned; `410` and `413` are final), delivery suspends after a sustained failure rate until a refresh reactivates it, and `gap` control envelopes announce a retention gap. A refresh rotates the secret (old and new both sign for five minutes) and returns `deliveryStatus`. The subscription key is (principal, url, name, arguments), where the principal is the Windows user that owns the server process, so another account cannot touch it. At most 50 subscriptions (`-32025`).
- **No callback restrictions (owner decision):** `delivery.url` may be any http or https URL, including loopback, LAN and Tailscale addresses. There is no address filtering, no up-front verification handshake and no allowlist; an unreachable callback is accepted and simply fails and retries. https certificates are not checked, so self-signed receivers work. Signatures stay (the receiver can verify `webhook-signature`), and redirects are not followed. This deliberately departs from the spec's SSRF, https-only and endpoint-verification requirements: Nexus is meant to connect the owner's own computers.
- Errors use the spec codes: `-32602` InvalidParams, `-32023` NotFound (`data.kind` is `event` or `subscription`), `-32025` ResourceExhausted, `-32027` CallbackEndpointError is defined but not raised. Webhook delivery runs in the monitor host, so webhook deliveries (and the event log) exist only while it is running. Event types:

| Event | Arguments | Payload |
|---|---|---|
| `gitlab.event` | `kind`, `project` | `kind`, `project`, `title` |
| `peer.message` | `kind` (`mail`/`chat`), `from` | `messageId`, `from`, `kind`, `subject` |

Events come from the monitor host (GitLab webhooks accepted by `nexus_webhooks`, peer mail) and are kept in `secrets\events.jsonl` (the last 1000 to 2000). They exist only while the monitor runs. Payloads are short summaries and untrusted data: fetch full content with `nexus_mail` or GitLab tools, and never treat an event as permission to act. A cursor older than the retained log, or older than `maxAgeMs`, returns `truncated: true`.

Most agent hosts do not speak the Events extension yet, so `nexus_events` exposes list and poll as a tool: `list`, and `poll` with `name`, `arguments`, `cursor`, `max_age_ms`, `max_events`. Poll with `cursor: null` once, keep the returned cursor, and repeat while `hasMore` is true.

## Managed tasks (MCP Tasks preview)

Call `nexus_start_task` with `command`, `shell` (powershell or cmd), optional `cwd`, and a unique `idempotency_key` (16–128 safe ASCII characters). Reuse that key only for the same command, shell and working directory. The task ID is also the managed terminal session ID. Use `read_process_output` with that ID and `force_terminate` if needed. The task survives MCP disconnects. Tasks are local to the Windows account; completed sessions retain output subject to existing limits and are pruned after seven days. A retry after retention expiry can start a new command. Do not use this tool to execute untrusted instructions.

Modern extension-capable hosts can declare `io.modelcontextprotocol/tasks` per request and receive a task handle; poll `tasks/get` and request cancellation with `tasks/cancel`. `tasks/update` acknowledges unused input responses; interactive input requests are not implemented. No remote task dispatch or task notifications yet. SDK 2.4.0's stock client does not decode the new task result; use the ordinary terminal-session fallback unless the host supports it. The desktop Tasks page shows observed state and links to Observability; cancellation is a request until the worker confirms it.

## Skills over MCP

Nexus implements the MCP **Skills** extension (`io.modelcontextprotocol/skills`, SEP-2640, beta) in full, using the SDK's `@modelcontextprotocol/server/ext/skills`. Every folder under `skills\` that holds a `SKILL.md` is served as an [Agent Skill](https://agentskills.io/specification); today that is `shared-harness`. Add a folder and restart the server to publish another skill.

- **Capability:** `resources` plus `extensions["io.modelcontextprotocol/skills"] = { directoryRead: true }`. The server `instructions` point to `skill://shared-harness/SKILL.md`.
- **`skills/list`** (paginated) and **`skills/get`** (by `SKILL.md` URI, listed or not) return the entry: the verbatim frontmatter and a complete manifest of every file with its URI, `sha256:` digest and byte size, plus `resultType: "complete"`, `ttlMs` (300000) and `cacheScope` (`public`). An unknown skill is `-32602`.
- **`resources/read`** serves each file under `skill://<skill>/<path>` (`text/markdown` for markdown), matching the published size and digest. Relative links in a skill resolve against its folder.
- **`resources/directory/read`** lists the direct children of a skill folder or subfolder (`inode/directory` for subfolders); a file or unknown URI is `-32602`.
- **Limits and rules:** at most 512 files and 16 MiB per skill; the folder name must equal the frontmatter `name`; symlinks and special files are skipped. An invalid skill is dropped with a warning on stderr and the other skills and all tools still serve. If `skills\` is missing, Nexus starts without the extension.

A host decides whether and how to activate a served skill; reading `SKILL.md` through `resources/read` does not activate it. Hosts that do not implement the extension see ordinary resources, so the same skill is still installed locally by `Install-Skills.ps1`.

## Invoke without writing a script

```powershell
.\Harness.ps1 tools
.\Harness.ps1 status
.\Harness.ps1 call find_files '{"pattern":"*.pdf","kind":"file","limit":10}'
.\Harness.ps1 call jev_browse '@browser-task.json'
.\Harness.ps1 doctor
```

Inline JSON and `@file.json` both work in PowerShell5.1 (the script passes inline JSON through a temporary file). The CLI calls the same MCP server and emits the same compact monitoring metadata. Shell output is machine-readable; the product UI renders readable views rather than dumping it.

## Text file reading

`nexus_read_file` is a read-only UTF-8 text reader based on Desktop Commander's paginated `read_file` design. It is not a PDF, Office, image or URL reader. Required: `path` (absolute local file path). Optional: `offset` (zero-based first line, negative to read from the end; default 0), `length` (1–250 lines; default 100). Results contain `start_line` (one-based), `total_lines`, `content`, `next_offset`, and `truncated`. Output is capped at 48 KiB; files over 8 MiB, binary files, invalid UTF-8 and protected paths are rejected. The result also carries the file's `sha256`.

`nexus_read_document` reads text from `.docx` (mammoth), `.xlsx` (exceljs) and `.pdf` (unpdf) inside the read roots, up to 25 MiB, with the same 48 KiB output cap. Pages by `offset` and `length`: docx by line (default 200), pdf by page (default 5, `total_pages` reported), xlsx by row (default 100; `sheet` picks a sheet, the result always lists `sheets`; up to 50 columns, tab-separated, formulas show their cached result). Scanned PDFs carry no text layer and return a hint instead of OCR. Images, legacy `.doc`/`.xls`, macros, comments and embedded objects are not read. `nexus_read_file` on these files now points to this tool.

`nexus_write_file` creates a UTF-8 text file (up to 1 MiB; `path`, `content`). Replacing an existing file requires `overwrite=true`; passing the `sha256` from `nexus_read_file` as `expected_sha256` refuses the write if the file changed since it was read. `nexus_edit_file` replaces exact `old_text` with `new_text` and changes nothing unless the text occurs exactly `expected_replacements` times (default 1). Both write through a temp file and rename, accept only the write roots (`NEXUS_WRITE_ROOTS`, `;`-separated; default Documents and Downloads) and refuse protected paths, binary and non-UTF-8 files.

The default read roots are the current user's Documents and Downloads directories. Set `NEXUS_READ_ROOTS` to a semicolon-separated list of absolute directories before launching the MCP server to override them. Paths are resolved before validation, including junctions and symbolic links; inaccessible or out-of-root paths fail. Generic reads exclude `.git`, `secrets`, browser profiles, `node_modules`, `.env` variants, private-key formats and `runs.jsonl`. This is a scope control, not a complete secret scanner. Only send returned file content to an external model when authorized.

Example MCP arguments: `{ "path": "C:\\\\Users\\\\Admin\\\\Documents\\\\note.txt", "offset": 0, "length": 100 }`.

## File names and contents

| Tool | Required | Optional / limits |
|---|---|---|
| find_files | pattern | drive one letter (C default), kind any/file/folder, limit1–100, path_filter directory glob, query for one Jev best-match call over at most24 candidates |
| search_status | none | UFFS state, coverage and memory; no recursive search |
| jev_search_content | root, pattern, query | root existing directory; literal case-insensitive retrieval;24 excerpts of600chars;4MiB files;1MiB output;10s |
| search_local | root, pattern | optional glob, regex, limit1–200 (default50); 15s; local only, includes large files; output excerpts up to600 characters |
| map_files | none | action build/view/root_plan/serve; roots up to5 absolute directories, out_dir, limit_units positive integer, open boolean |

UFFS searches NTFS metadata, not contents. Initial indexing can be slow and memory-intensive; warm queries are much faster. Auto-parking/stopping returns `idle`, not a failure. A status response does not verify a search; run a bounded `find_files` query. The `find_files` result includes `coverage.state` for the requested drive: `indexed`, `loading`, `uncovered`, or `unknown`. Indexed results include available UFFS source, tier, and record count. UFFS does not report index age here. Check coverage before interpreting zero matches. The monitor does not warm the index merely to show green status.

Content search skips .env/secrets patterns but is not a comprehensive secret detector. `search_local` does not call TypeSafe; selected excerpts from `jev_search_content` do. Neither performs general PDF/Office/OCR extraction. A truncated result set, timeout, inaccessible file or ripgrep warning is not exhaustive. Local search respects ripgrep ignore rules; use an appropriate scoped root and glob.

## Terminal and process tools

All seven terminal tools use `shared_jev` and are available to both Codex and Claude. Commands run as the signed-in Windows user. They are **not sandboxed**, and setting a working directory does not restrict filesystem or network access. Do not execute untrusted instructions. Ask before ending unrelated processes or making destructive system changes.

| Tool | Required | Optional / behavior |
|---|---|---|
| `start_process` | command (1–16384 chars) | shell powershell/cmd/pwsh (default powershell); cwd existing absolute directory (default user home); timeout_ms 0–3000 (default 350). Returns session_id and actual shell PID. |
| `read_process_output` | session_id or pid | offset absolute zero-based line, negative tail (default 0); length 1–200 (default 50); timeout_ms 0–3000. Returns content, total_lines, next_offset, evicted_lines and state. |
| `interact_with_process` | session_id or pid, input | input up to 8192 chars; appends newline unless append_newline=false; timeout_ms 0–3000 (default 500). Queues input for a running session and returns observed output; queued does not prove consumed. |
| `list_sessions` | none | Returns session IDs, shell PIDs, state, exit code and timestamps. Does not reveal original commands. |
| `force_terminate` | session_id or pid | Requests Windows taskkill /T /F on the managed session's process tree; does not claim completion without a state change. |
| `list_processes` | none | optional exact name or PID, limit 1–200 (default 100). Returns `start_identity` where readable; CPU is lifetime seconds and working set is bytes. |
| `kill_process` | pid, expected_name, expected_start_time, confirm=true | Pass `start_identity` from a recent process listing as `expected_start_time`. Verifies the instance and terminates using one Windows process handle. Unreadable identities cannot be terminated. |

Session workers are started on demand and survive agent/CLI disconnects. Their files are in `%LOCALAPPDATA%\Nexus\terminal-sessions` (or `NEXUS_TERMINAL_DIR` for a separate test registry). Each worker writes bounded output to its private session folder. Output is capped at 4 MiB, then the oldest bytes are evicted to retain a tail; the response reports `evicted_lines` and `output_limited`. A new start prunes completed records older than seven days and moves the oldest completed records to the registry's `archive` folder at the 64-record limit. Archived output remains on disk outside the live registry and its seven-day pruning. Active sessions are protected. `session_id` is preferred over PID to avoid ambiguity after PID reuse. There is no pseudo-terminal; some terminal applications need an interactive console and will not work with redirected stdin/stdout. PowerShell, CMD and pwsh are supported shell selectors; `pwsh` must be installed separately. Terminal commands can launch other executables, including Node, Python and SSH.

Example call arguments: `start_process` `{ "command": "Get-Date", "shell": "powershell" }`. Then call `read_process_output` with the returned `session_id`, `{ "session_id": "<uuid>", "offset": 0, "length": 50 }`. Use `interact_with_process` only for programs that are designed to read standard input. Use `force_terminate` for any managed Nexus session rather than `kill_process`.

Follow `next_offset` when paging. While a session is running, an unfinished final line is returned again at the same offset so its continuation is not missed. A line longer than the response limit is returned in pieces: while `next_char_offset` is not null, repeat the call with the same `offset` and `char_offset` set to it; nothing is lost.

The desktop app's Agents & tools page groups these tools under Terminal and refreshes its session registry view every ten seconds. It shows IDs, PIDs, shell, recorded state, duration and exit code, without command or output contents. Each worker refreshes a heartbeat every two seconds; a session that still looks running but has had no heartbeat for ten seconds is reported as `error` ("Worker stopped unexpectedly", output kept, the command process may still be running), so a crashed worker or a reused PID never shows as running. This is registry reconciliation, not a process inspection: use `list_processes` to confirm the command itself. The catalog is read-only; call tools through the agent's MCP connection.

The terminal worker removes API-key-like variables from the environment before starting a shell. This is not a general secret scanner. Raw command text is held briefly in a local launch file and is removed after the worker reads it. Command and input text are not stored in Nexus monitor metadata. Follow your organization's approval controls; `confirm=true` is a tool argument, not a human approval system.

## Peers, mail and chat

When generating or entering a pairing code in Devices, choose whether this computer should reply automatically to that device. Each computer sets its own preference. The Auto-reply column in the paired computers table changes it later.

For GitLab event forwarding, `nexus_webhooks configure` accepts `forwardEvents`. For example, `["release"]` forwards release notifications without forwarding issue chatter to the selected peers. A retry with the same GitLab event UUID is acknowledged without repeating notifications or forwarding while the event remains in the log.

Nexus installations connect directly. Open **Inbox** in the monitor or desktop app to search by device name or latest preview, see unread counts, and read and write a device's chat and mail thread (Ctrl+Enter sends). Open **Devices** to control each computer's connection, chat, mail, auto-reply and autonomy in one table; Pair a computer generates or accepts a one-time code. The This computer panel shows addresses, Tailscale and firewall state, and responder defaults. Agent hosts that run hooks get unread messages through `nexus-hook.mjs`, and Claude Code started with `claude-nexus` receives them as channel events.

**Your own computers pair by themselves.** Tailscale authenticates every packet on the tailnet and knows which account owns each device, so Nexus asks every online Windows device of the same account for a handshake (`/peer/hello`, about every 30 seconds) and a device that answers from an address of your own account is trusted: both sides store each other's token in that one exchange. Nothing is typed. Phones, Linux machines, other people's devices and sleeping computers are skipped, and a device without Nexus leaves nothing behind.

Device status uses Tailscale presence when the saved address matches a Tailscale device; otherwise Nexus checks the paired receiver directly, including over the office LAN. Online confirms the receiver responded, not that messaging credentials were verified. Unexpected responses remain Paired (status unknown).

**Other people (teammates) and computers outside the tailnet pair with a code**, like AnyDesk: *Generate code* shows `nexus-...` (it carries this computer's name and addresses; single use, valid ten minutes), the other person pastes it under *Enter a code*, and both sides are paired. The same exists as `nexus_peers`: `add` / `set` with `outbound_token` for the manual two-step flow, and `list`, `set` (`enabled`, `allow_mail`, `allow_chat`) and `remove`. Switched-off or denied peers are refused in both directions; tokens live in `secrets\peers.json` and are never listed.

**Over the internet (no VPN or open port):** run `runtime
ode.exe relay-client.mjs setup https://<your relay>` once on each computer and restart the monitor; both sides need it. Pairing codes then also carry a relay address. `relay/worker.mjs` is the Cloudflare Worker (deploy: `npx wrangler@4 deploy` in `relay/`; free plan, only the relay owner needs an account). Each computer keeps an outbound WebSocket; requests are sealed with AES-256-GCM using a key that travels only in the pairing code, so treat codes and `secretselay.json` as secrets. The relay stores nothing: an offline computer refuses delivery. Only `/peer/message` and `/peer/pair` are reachable.

**Firewall:** when Nexus runs as administrator it creates the inbound rule for port 8770 ("Nexus peers") by itself if no enabled Nexus rule exists. Otherwise the page shows "Port 8770 blocked" with an *Open port* button that works only when Nexus is elevated.

**Messages:** `nexus_mail` `send` (kind `chat` or `mail`) posts straight to the other computer. There, an agent that calls `nexus_mail` `wait` is released within about a second (the call blocks up to `timeout_ms`, default 30 s, max 55 s; loop it to stay listening), and the same arrival is a `peer.message` event for `nexus_events` or the MCP Events extension (poll, push or webhook).

**Agent auto-reply** applies to chat from enabled paired devices, including devices paired by code. The computer switch controls all peers. Each device can disable replies or override the default autonomy. The responder runs Claude Code, falls back to Codex on PATH, or uses the configured command and arguments from `secrets\agent-responder.json`. With Claude Code, Safe lets your own computers use Nexus tools plus GitLab and gbrain reads; teammates get an isolated run (empty folder, no user settings or memory) in which only ToolSearch and the GitLab server are loaded, with GitLab reads pre-approved. Full uses `bypassPermissions`. Each reply is a new agent session (model `sonnet` unless `model` is set) that receives the last 12 thread messages and what live sessions on this computer are doing. `nexus-hook.mjs` records that: each session publishes a line with `nexus-hook.mjs working <session> "<what>"` (the only part teammates see; own computers also see folder and last request), and it is told what was auto-replied. `nexus-hook.mjs install` points the Claude Code hooks at this installation; `Install.ps1 -RegisterAgents` runs it. Codex and custom commands use their configured permissions. Replies carry a hop number and stop at the hop limit (six by default) or when the agent returns `NO_REPLY`. Runs time out after five minutes by default and are serialized per peer.


`nexus_webhooks` configures the GitLab receiver. In GitLab add a webhook with the `receiver_url` from `status` and the secret token from `secrets\webhook-secret.txt` (never returned by the tool). `configure` chooses the accepted event kinds (`release`, `pipeline`, `merge_request`, `push`, `tag_push`, `note`, `issue`), the GitLab projects (paths such as `ssm/shared-computer-use`; empty means all), which kinds raise a Windows notification, and which peers (`forward`) receive each accepted event as mail. Events that are not accepted get HTTP 202 and are dropped; the Updates page shows the accepted events. A forwarded event goes only to peers that are on and allowed mail; failures never fail GitLab's delivery.

`jev_desktop` runs one task at a time across every agent on the computer. A second agent receives "Desktop is in use by another agent" naming the holder; the lock is refreshed every two seconds and taken over ten seconds after a crashed holder stops refreshing it.

## Network investigation

`network_probe` always returns local interfaces. Optional `system` gathers Windows IP configuration, firewall profiles, routing table and neighbor cache. `quic_ports` sends a QUIC packet with a reserved version over UDP and reports `quic_reply` or `no_reply` (blocked, or not a QUIC server). `dns_servers` asks each listed server for A records directly. Supply `host` for DNS/reverse DNS and optional TCP `ports` (up to100), `ping`, `trace`, or `tls_port`. Supply `url` for a HEAD request with redirects reported but not followed. TLS records peer certificate dates, subject, issuer, negotiated protocol and validation status. `timeout_ms` is100–10000 (default2000).

An explicit IPv4 `subnet` from /24 through /30 triggers bounded ICMP discovery, up to16 probes at once and a maximum timeout of5000ms. No subnet is scanned by default. A timeout or missing ICMP response does not prove a host is absent. Windows tools supply ping, trace and system observations; unavailable commands and errors are returned. This is not a packet capture, UDP scanner, SNMP inventory or a substitute for authenticated device discovery.

map_files produces classification maps, review pages, treemaps and dry-run root proposals. It does not move files. Its serve action starts a separate loopback review endpoint on8766 for explicit review/save interactions. The operating monitor on8769 is read-only. Do not conflate the two.

## Browser tasks

`web_scrape` reads a public HTTP(S) URL without starting Chrome or using an LLM. The required `url` must not contain embedded credentials. Optional `format` supports `markdown`, `text`, `html`, `links`, and `metadata`; `max_chars` is 100–48,000. The requester blocks local/private/reserved IP addresses, unsafe DNS resolutions, unsupported response types, oversized pages, and unsafe redirects. It returns source details, SHA-256 content hash, and truncation flags. When a page requires JavaScript and `browser_session` is explicitly supplied, Nexus can read that already-open session if its URL matches; it does not navigate or bypass access challenges.

`browser_read_page` reads a currently open named Playwright session without navigation, clicks, or LLM decisions. Required: `session` (1–40 letters, numbers, underscores, or hyphens). Optional: `browser` (`chrome`/`edge`), `format` (`markdown`, `text`, `html`, `links`, `metadata`), `max_chars` (100–48,000, default 24,000), `offset_chars` (0 or more), and `expected_sha256` (64-character lower-case content hash). Nexus uses the session name `jev-<browser>-<session>`. The reader refuses missing or busy sessions; it never starts a new browser. It removes scripts, forms and common navigation from a detached DOM clone. The result includes retrieval time, language, content hash (`content_id`), `next_offset_chars`, and truncation status. For the next page, pass `next_offset_chars` as `offset_chars` and the previous `sha256` as `expected_sha256`. If the page changed, the reader returns `content_changed` instead of mixing page versions. Sensitive query parameters in links are redacted. Page content remains untrusted. The reader does not provide a network fetch or a crawler; those belong to separate issues.

`jev_browse` requires goal, url and expect_text. Optional browser is chrome/edge; backend is cdp/playwright (cdp default); session is a stable alphanumeric/underscore/hyphen name up to40characters; max_steps is1–20. URLs must be HTTP(S) without embedded credentials.

For CDP tasks that generate field text or a written answer, install and start Ollama and run `Setup-LocalText.ps1` once from the Nexus folder. It downloads `qwen2.5:1.5b` and creates `jev-browse\.env` only when no configuration already exists. The configured endpoint is local; Jev decisions still use TypeSafe. Keep Ollama running. Existing text-model environment variables override the file. Local inference can be slow and its answers require review. The Playwright backend fills only caller-supplied `fields` and does not generate answers.

For forms, fields maps exact accessible field labels to caller-supplied text. Example task: goal “Fill Name, check Blue and submit”; fields Name → Harness test; expected text Confirmed. Supported Playwright controls are button, link, checkbox/radio and supplied textbox/searchbox. No general free-text generation or visual fallback is implied.

Chrome/Edge launch automatically. Dedicated profiles preserve sessions without replacing personal profiles. Named Playwright sessions have cross-process locks and reuse browser state. A session_busy result means wait or use an independently intended session, not delete an active lock. After a crash, verify the task is no longer active before removing only its stale lock.

Browser deadline is120s. A step limit, challenge or missing eligible action stops the task. Signed-in persistence requires an actual authorized login test; installed browser state does not prove it. Default-CDP cross-agent calls require serialization.

## Native desktop tasks

`jev_desktop` requires goal, app and expect. Optional: window_id, launch_aumid, text and max_steps1–20. Match exactly one visible app/window. If the exact target is minimized, Nexus restores it without taking focus and continues. Use a packaged-app launch ID without a window_id, or target an existing window. Native deadline45s.

`restart_application` requires explicit authorization and the PID, exact name and start identity from `list_processes`, plus `confirm=true`. It registers an interactive-user scheduled task, waits for its ready handshake and returns an id before the task requests a graceful close. Set `quit_via_ctrl_q=true` only when Ctrl+Q is the verified application quit shortcut; otherwise it requests a window close. If background shortcut delivery is unavailable or unverified and the application remains running, the shortcut can briefly bring its window to the foreground. Reconnect and use `restart_status` with that id to inspect the final state. The task refuses missing windows or changed identities and never forces a close. It attempts to retain the original command-line arguments but does not restore the working directory; applications requiring a particular working directory or packaged activation may not restart correctly. A running new PID alone does not prove the application restored its session. Restart records are stored under the current user's LocalAppData `Nexus\restarts` directory.

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

## Experimental visual intelligence

Tracked by GitLab #114–#126. These tools require explicit absolute paths; they do not capture screens automatically.

- Local operations: `visual_diff(path,references:[second_path])`, `visual_remember(path,label)`, `visual_search(query)`. Stored normalized PNGs and metadata live in project-scoped secrets/visual-assets. Default search is bounded label matching. Semantic mode ranks up to 24 authorized labels with Jev; enable the project in NEXUS_VISUAL_OUTBOUND_PROJECTS and confirm upload. It does not upload raw assets.
- All external operations require operator environment variables `NEXUS_VISUAL_OUTBOUND=1`, `NEXUS_VISUAL_OUTBOUND_ROOTS` (semicolon-separated absolute approved staging directories), and per-call `confirm_upload:true`. Stage only task-authorized, redacted images. Never stage credentials or private production data. Use visual_redact with explicit pixel rectangles to create a new local PNG. Automatic sensitive-region detection is not provided.
- Supply `path`, `question` and optional `threshold` (>0.5, default 0.8). Reference images are passed in `references` (up to three). Questions may refer to image_0 (current) and image_1 through image_3 (references).
- `visual_verify` and `visual_compare` return satisfied, not_satisfied or uncertain. `visual_classify` and `visual_route` accept named string `criteria` (2–12 options); a null selection is valid. Routing never executes an action.
- `visual_grade` accepts `levels` (2–10 ordered descriptive strings), returns a score and confidence; low confidence is uncertain. `visual_find` and `visual_extract` require one image; reject low-confidence/absent/ambiguous targets. Returned boxes use pixels in the oriented original; extract stores a crop, not OCR.
- `visual_contract` accepts `contract_id` and `checks` (1–12 assertions). All must pass for a pass. The returned contract hash includes criteria, threshold and normalized reference hashes. Use visual_contract_registry to define, list, get and evaluate immutable versioned contracts with pinned reference hashes. Use visual_recipe to define and evaluate state transitions; it returns a next action ID and postcondition but never executes it.
- `visual_wait` and `visual_watch` observe a caller-maintained file for at most 30 seconds plus request latency. Use only a dedicated approved staging file whose future frames are authorized. They return observations but do not create durable watches, publish events or perform capture. For a durable watch use visual_watch_manage with action create, list or cancel, a unique ID, approved file, question and confirm_future_frames:true. The managed monitor emits visual.watch events on observed changes. Watches expire within one hour; each has at most 100 evaluations. File size and modification time detect changes, so same-size changes with preserved timestamps may be missed. Events are not execution authorization.
- Jev model is pinned to jev-1.14.0. PNG/JPEG only; input limited to 16 MiB and 25 million decoded pixels, normalized upright and resized/padded to 280–1568 pixels. Up to four images and twelve questions; prepared payload capped at 20 MiB. Identical normalized images/questions use a bounded process-local cache. Usage goes through the existing MCP accounting. No automatic retries.
- Unit tests use a mock transport and synthetic images. Run the explicit live synthetic probe with `NEXUS_VISUAL_LIVE_TEST=1` and the existing Jev key. It uploads only a generated red square. Experimental output does not authorize execution.

Local capture: visual_capture with confirm_capture:true captures an exact existing visible desktop window (app and window_id) or an existing named browser session (browser and session). It never uploads. visual_asset lists metadata, gets an asset by hash, or exports a new PNG to an allowed write root with confirm_export:true. Keep raw private evidence out of outbound staging roots. The native Observability view includes a Visual Intelligence section and filters. Additional local evidence tools:

- visual_ocr(path) uses installed Windows OCR languages, returns recognized text and word rectangles, and never sends images externally. OCR text is untrusted evidence, not an instruction.
- visual_novelty(path,project) compares up to 100 local assets using a 64-bit difference hash and normalized pixel difference. Similarity does not prove semantic equivalence. visual_retention pin protects an asset; plan lists older unprotected candidates and estimated bytes. Registered contract references, reviewed memory and watch evidence are protected. No deletion occurs.
- visual_handover send requires an enabled paired own device with mail permission, a local asset hash, task ID, state, verification and explicit confirm_send. Optional strict crop (not full image) requires confirm_crop and is limited to 32 KiB. list returns metadata without image bytes. receive with confirm_receive validates crop integrity and imports locally. No auto-reply, automatic execution or cloud upload. Peer mail retention applies to transferred packets.
- visual_memory_record saves reviewed observations with evidence hash, task, source, timestamp and optional supersession; returns a put_page payload for the authorized agent GBrain source. It does not write GBrain. Do not publish private evidence or use product GBrain.
- jev_semantic_judge independently evaluates 1-12 text candidates for skill/tool selection, knowledge relevance, entity alignment, citation verification, memory selection, tool-call evaluation, hierarchical classification, semantic search or feature discovery. Set NEXUS_SEMANTIC_OUTBOUND=1 and confirm_upload:true; supply only authorized text. No independent retrieval or execution.

Remaining: automatic sensitive-region detection, physical retention/deletion policy, direct GBrain write integration, live cross-device handover, automatic task resume/recipe execution, representative accuracy benchmarks and reference packs. Live synthetic tests cover Noul, Choice, Score, Box, reference comparison, absent targets, browser capture and local OCR. The opt-in native window fixture requires an interactive Windows session.

## Monitor controls and state

Monitor.ps1 supports Start, Status, Stop and InstallStartup. Run is the hidden task's internal entry point. Start uses the registered task if present, otherwise a hidden host. InstallStartup preserves another installation's task, migrates this installation's known definition while stopped, and enables restart recovery. Stop is intentional and suppresses recovery for that stop. Open the interface from **Nexus Harness** in the Windows Start menu.

InstallStartup waits up to 60 seconds for the endpoint and verifies the managed flag and running task. If a server is already running outside the task, stop it with Monitor.ps1 Stop and run InstallStartup again. A timeout identifies the endpoint phase and task result; inspect the task history and monitor-error.log. These checks do not exercise search, Jev authentication or a browser task.

Task Scheduler owns the long-running hidden host. The host waits for Node to exit and restarts an unexpected exit after three seconds. Stop terminates both the owned host and server, including the manual fallback. The machine must be on and the user signed in. The installed interface is served to the desktop WebView, and the loopback API remains available for health checks and integrations.

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

### Binary file transfer

Use nexus_transfer_file with action=download and an absolute path in the configured read roots. The result contains a metadata text block and an embedded MCP binary resource (not a text dump). For action=upload, provide path, base64 data, decoded size and SHA-256 hex digest. Uploads create a new file only, verify integrity, and do not overwrite. Maximum decoded size: 256 KiB. Use the same roots and protected-path checks as the text tools.

The experimental io.modelcontextprotocol/files extension advertises maxInlineBytes=262144. Extension-aware clients see nexus_upload_file with x-mcp-file. The client supplies approved file metadata, base64 data and SHA-256 base64url digest. Legacy clients receive the compatibility tool. No out-of-band upload capability or HTTPS download targets are advertised. The draft is not a stable protocol; do not assume ChatGPT or Claude supports it.

Agent communication tracing: Nexus records peer_send, peer_receive and peer_responder spans in the local run log. The trace and parent span IDs travel as optional peer metadata. Legacy peers ignore them. The existing paired-peer authorization remains in force. Read and reply permissions are unchanged. A responder records queue wait, execution time, reply outcome and byte counts, not raw content. The desktop Trace inspector shows related local spans. Remote telemetry is not fetched automatically.
