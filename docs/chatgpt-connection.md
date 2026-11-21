# ChatGPT connection for Nexus

## Local MCP bridge (Windows-first)

Nexus includes a restricted Model Context Protocol (MCP) adapter at jev-use/chatgpt-bridge.mjs. It starts the existing Nexus tool server as a child process. It does not create an inbound network listener.

A local MCP client can launch the following command with arguments:
- Command: <Nexus install>\runtime\node.exe
- Arguments: <Nexus install>\jev-use\chatgpt-bridge.mjs
- Environment: NEXUS_CHATGPT_ALLOW_FILES=0 (default)

The adapter exposes list_processes, list_sessions and search_status by default. Explicit local NEXUS_CHATGPT_ALLOW_FILES=1 adds find_files, search_local, nexus_read_file and nexus_read_document. Existing Nexus read-root and protected-path checks still apply.

Remote shell execution, file writes, process termination, remote browser actions and desktop control remain disabled. Requests for excluded tools return an explicit policy error even when clients invoke a hidden tool directly. Nexus must never treat a chat conversation or a tool description as permission to bypass local controls.

Users must explicitly connect the app in ChatGPT. Installing Nexus alone never grants ChatGPT access.

## Remote connection

The local stdio adapter is not a remote connection from ChatGPT iOS or web. ChatGPT custom remote MCP support depends on account/workspace plan, supported surface and permissions.

A supported private connection can run the OpenAI Secure MCP Tunnel client on the device. It calls the local stdio server through a tunnel with outbound HTTPS. An eligible ChatGPT workspace needs an approved custom MCP app, tunnel identity and authorization. Do not store API keys in source files, logs or chat. Do not open arbitrary incoming firewall ports.

For a future Nexus-managed multi-device service, use an outbound device connection and central gateway with per-device identity, signed requests, device allowlists, local permission checks, revocation, audit records, replay protection, rate limits, bounded output and offline detection. The gateway must never forward arbitrary commands without device-owner approval. Keep the transport independent from the tool dispatcher to support Linux later.

## Release gates

- Test tool discovery and real read-only calls through the adapter.
- Confirm an unadvertised process or write tool cannot execute.
- Test that file access requires explicit opt-in.
- Validate OpenAI tunnel transport and authenticated ChatGPT invocation on an eligible account before claiming remote support.
- Add a local approval UI and scoped action grants before enabling command execution or desktop control.
- Keep this integration independent from installer recovery and Hermes plugin compatibility.

References:
- https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- https://help.openai.com/en/articles/20001256-plugins-in-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
