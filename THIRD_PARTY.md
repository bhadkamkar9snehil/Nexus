# Upstream software

- Nexus terminal suite adapts Desktop Commander MCP's MIT-licensed terminal session design, Windows process-tree termination behavior, bounded output and separate managed-session/external-process operations. Reference: https://github.com/wonderwhy-er/DesktopCommanderMCP (`src/terminal-manager.ts`, `src/tools/improved-process-tools.ts`, `src/tools/process.ts`, and `src/utils/process-tree.ts`). Nexus uses a distinct per-session detached worker with local state for cross-agent persistence. No upstream source file was copied into Nexus.


- Monitor UI reuses internal `ssm/Chitragupta` source at commit 3094d86ed0a3dcfa7745dabbd2b0e5b40adfc328. Attribution, exact files and adaptations are recorded in monitor-ui/PROVENANCE.md. No Chitragupta runtime or knowledge store is modified or required.
- React/React DOM (MIT), Lucide (ISC), Radix Slot (MIT), class-variance-authority (Apache-2.0), clsx/tailwind-merge (MIT), Tailwind (MIT), esbuild (MIT) retain their npm package notices. Generated app.js.LEGAL.txt accompanies the bundle.
- Geist and Geist Mono variable Latin fonts are distributed through Fontsource 5.3.0 under SIL OFL 1.1; their full licenses accompany local font assets in monitor-ui/dist.

- jev-browse v0.16.0, MIT, https://github.com/0x7067/jev-browse at 07c2dce0983181d6b2fee3dbdc8b892dae562656. License in jev-browse/LICENSE.
- Cua jev-use TypeScript example from cua-driver-rs-v0.38.0, MIT, https://github.com/trycua/cua/tree/cua-driver-rs-v0.38.0/libs/cua-driver/examples/jev-use. License in CUA-LICENSE.
- npm packages retain their own upstream licenses and are installed through the lockfile.
- Playwright CLI 0.1.24 is installed from npm. Its published package pins a Playwright alpha build. Both are Apache-2.0; inspect the lockfile for exact versions.

The source checkout excludes binaries. Deployment bundles include Node.js, the installed Cua Driver and UFFS executables, and ripgrep, with licenses and source links. UFFS is MPL-2.0 (https://github.com/skyllc-ai/UltraFastFileSearch), ripgrep is dual MIT/Unlicense (https://github.com/BurntSushi/ripgrep), and Node includes its full license notices. Cua's MIT notice is CUA-LICENSE. npm dependencies retain their license files in node_modules.

The first deployment bundle uses Node v22.22.0 (https://github.com/nodejs/node/tree/v22.22.0), UFFS v0.6.47 (https://github.com/skyllc-ai/UltraFastFileSearch/tree/v0.6.47), ripgrep 15.1.0 (https://github.com/BurntSushi/ripgrep/tree/15.1.0) and Cua Driver 0.38.0 (https://github.com/trycua/cua/tree/cua-driver-rs-v0.38.0). Runtime SHA256.json lists executable integrity hashes.
