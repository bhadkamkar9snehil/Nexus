# ADR 0002: Preserve terminal output across partial-line pagination

- Status: Accepted (documented on 2026-11-21)
- Original decision date: Unknown
- Related issue: https://github.com/bhadkamkar9snehil/Nexus/issues/68

## Context

Terminal output arrives asynchronously. A response may reach its character limit inside a large line. The last line may also remain unfinished while its process continues to write. Simple line-based cursors can lose data at either boundary.

## Decision

The terminal session reader uses absolute line offsets and a character offset within the first returned line. For an oversized line, the next response starts at the remaining character offset instead of skipping that line. When the last line is unfinished and the process is still live, the next read starts at that line again. This is deliberate re-reading, not a duplicate completed line.

## Reasons

The approach preserves output continuity and gives callers a bounded response size. A partial line must not be treated as complete output.

## Alternatives

Treating every page as a set of complete lines could skip bytes. Returning unlimited lines would violate bounded output. The original comment does not document other evaluated alternatives.

## Consequences

Callers must respect both next_offset and next_char_offset. They may see a repeated prefix while a live line continues. Pagination tests must verify no output is lost.

## Relevant source

- jev-use/terminal-sessions.ts: snapshot, waitForUpdate
- Existing terminal-session tests and tool response contracts
