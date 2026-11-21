# ADR 0001: Require explicit plugin provider selection

- Status: Accepted (documented on 2026-11-21)
- Original decision date: Unknown
- Related issue: https://github.com/bhadkamkar9snehil/Nexus/issues/68

## Context

The Nexus capability registry supports optional providers. A provider may require permissions and may send content across a process or network boundary. Nexus must not silently switch from its built-in core to another provider.

## Decision

The Nexus core remains the default when no provider ID is supplied or when the ID is nexus.core. An optional provider must be explicitly selected and enabled. The registry rejects providers that lack the requested capability. It never selects a remote or cloud provider as an automatic fallback.

## Reasons

This keeps permission scope and data-transfer choice explicit. It avoids surprising behavior when an optional provider fails or is unavailable.

## Alternatives

An automatic fallback to another provider would reduce manual selection but could change execution and data-transfer boundaries. No historical comparison or review record was found in the source comment.

## Consequences

Callers must opt into an optional provider. They must handle errors when a selected provider is disabled or lacks a capability. The registry does not guarantee that the external process uses an offline mode.

## Relevant source

- jev-use/plugin-capabilities.ts: select and execute
- AGENTS.md: plugin policy and Firecrawl local-mode constraint
