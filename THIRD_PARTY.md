# Upstream software

- The MCP server and client use the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/client` 2.4.0, Apache-2.0) with zod 4.2.1 (MIT) for request schemas. `jev-use/events-extension.ts` implements the MCP Events extension (`io.modelcontextprotocol/events`, SEP-3415, https://github.com/modelcontextprotocol/ext-events, spec in `specification/beta/events`: poll, push and webhook delivery, Standard Webhooks signing) from its written specification; no SDK offers it yet and no upstream code was copied.

- Nexus terminal suite adapts Desktop Commander MCP's MIT-licensed terminal session design, Windows process-tree termination behavior, bounded output and separate managed-session/external-process operations. Reference: https://github.com/wonderwhy-er/DesktopCommanderMCP (`src/terminal-manager.ts`, `src/tools/improved-process-tools.ts`, `src/tools/process.ts`, and `src/utils/process-tree.ts`). Nexus uses a distinct per-session detached worker with local state for cross-agent persistence. No upstream source file was copied into Nexus.
- The optional `firecrawl-provider.ts` adapter implements the published Firecrawl v2 HTTP routes independently. No Firecrawl implementation code or binaries are copied or redistributed. Firecrawl Local itself is AGPL-3.0 (https://github.com/firecrawl/firecrawl), so any future bundling requires a separate license review.
- `web_scrape` uses linkedom 0.18.12 (ISC, https://github.com/WebReflection/linkedom) for HTML parsing and node-html-markdown 1.3.0 (MIT, https://github.com/crosstype/node-html-markdown) for Markdown conversion. The HTTP network guard and retrieval code are implemented independently in Nexus; no Firecrawl source is included.
- `nexus_read_document` uses established npm libraries: mammoth 1.12.0 (BSD-2-Clause) for .docx, exceljs 4.4.0 (MIT) for .xlsx and unpdf 1.6.2 (MIT, bundling Mozilla PDF.js, Apache-2.0) for .pdf. No parser is written in Nexus.
- `nexus_read_file` adapts the line-pagination and filesystem validation design from Desktop Commander MCP (MIT), https://github.com/wonderwhy-er/DesktopCommanderMCP, `src/tools/filesystem.ts`. Nexus implementation is separate and text-only, with distinct read-root and sensitive-path policy. Retain upstream project attribution; no Desktop Commander code is copied verbatim in this first tool.


- Monitor UI reuses internal `ssm/Chitragupta` source at commit 3094d86ed0a3dcfa7745dabbd2b0e5b40adfc328. Attribution, exact files and adaptations are recorded in monitor-ui/PROVENANCE.md. No Chitragupta runtime or knowledge store is modified or required.
- React/React DOM (MIT), Lucide (ISC), Radix Slot (MIT), class-variance-authority (Apache-2.0), clsx/tailwind-merge (MIT), Tailwind (MIT), esbuild (MIT) retain their npm package notices. Generated app.js.LEGAL.txt accompanies the bundle.
- Geist and Geist Mono variable Latin fonts are distributed through Fontsource 5.3.0 under SIL OFL 1.1; their full licenses accompany local font assets in monitor-ui/dist.

- jev-browse v0.16.0, MIT, https://github.com/0x7067/jev-browse at 07c2dce0983181d6b2fee3dbdc8b892dae562656. License in jev-browse/LICENSE.
- Cua jev-use TypeScript example from cua-driver-rs-v0.38.0, MIT, https://github.com/trycua/cua/tree/cua-driver-rs-v0.38.0/libs/cua-driver/examples/jev-use. License in CUA-LICENSE.
- npm packages retain their own upstream licenses and are installed through the lockfile.
- Playwright CLI 0.1.24 is installed from npm. Its published package pins a Playwright alpha build. Both are Apache-2.0; inspect the lockfile for exact versions.

The source checkout excludes binaries. Deployment bundles include Node.js, the installed Cua Driver and UFFS executables, and ripgrep, with licenses and source links. UFFS is MPL-2.0 (https://github.com/skyllc-ai/UltraFastFileSearch), ripgrep is dual MIT/Unlicense (https://github.com/BurntSushi/ripgrep), and Node includes its full license notices. Cua's MIT notice is CUA-LICENSE. npm dependencies retain their license files in node_modules.

The first deployment bundle uses Node v22.22.0 (https://github.com/nodejs/node/tree/v22.22.0), UFFS v0.6.47 (https://github.com/skyllc-ai/UltraFastFileSearch/tree/v0.6.47), ripgrep 15.1.0 (https://github.com/BurntSushi/ripgrep/tree/15.1.0) and Cua Driver 0.38.0 (https://github.com/trycua/cua/tree/cua-driver-rs-v0.38.0). Runtime SHA256.json lists executable integrity hashes.
