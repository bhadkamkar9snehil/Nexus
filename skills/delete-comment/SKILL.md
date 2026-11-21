---
name: delete-comment
description: Audit, classify, and remove unnecessary comments without changing executable behavior. Apply strict comment-ratchet enforcement, record unresolved debt as issues, and preserve technical decisions in ADRs. Use for whole repositories, changed files, directories, or one file.
---

# Delete comments safely

Treat the current repository as the only active project. Do not change another repository before the current project passes review. Run the process in a dedicated branch and never merge automatically. Honor repository instructions and existing release gates before edits.

## Discover the project

1. Read the repository instructions, current branch, remotes, working-tree status, CI, language versions, and build commands.
2. Identify the canonical upstream. Do not assume a public mirror is the source used for releases.
3. Inventory tracked maintained code, tests, build scripts, configuration files, and generated artifacts.
4. Use language-specific tokenization. Do not count comment-looking text inside strings, regular expressions, or URLs.
5. Keep legal notices, compiler directives, mandatory annotations, shebangs, and generator markers. Document each exception by exact file or exact token and its reason.
6. Preserve dirty files, active work, and release assets. Use an isolated checkout if another agent owns the working tree.

## Audit commands for Nexus

First install existing JavaScript dependencies in an isolated checkout:

    npm ci --prefix jev-use --ignore-scripts

Run one of these commands from the repository root:

    node tools/comment-ratchet/check.mjs audit
    node tools/comment-ratchet/check.mjs audit --json
    node tools/comment-ratchet/check.mjs audit --json --path jev-use/typescript/
    node tools/comment-ratchet/check.mjs audit --json --path jev-use/typescript/core.ts
    node tools/comment-ratchet/check.mjs check

For incremental work, use git diff to list changed files against the intended base. Review only those files, then run the full repository check. The audit command's --path option restricts the report, not the required final enforcement.

The tracked baseline is tools/comment-ratchet/baseline.json. Create it only once with the init command. Subsequent reductions use the shrink command after comment removal. Never reinitialize a baseline or increase its permitted comments to make CI pass. Baseline identities combine exact comment text with adjacent non-comment code context. A changed or moved comment requires review.

When adapting this skill to another repository, reuse its rules and report shape. First choose a parser and lint tool appropriate to that project's languages. Do not copy Nexus's Windows-specific PowerShell parser into an unrelated project without checking its environment.

## Classify each comment

Inspect the implementation and relevant tests before assigning exactly one category.

- Tautology: repeats behavior already clear in the implementation. Delete.
- Excuse: admits or justifies a shortcut, workaround, fragile design, ignored failure, or unfinished implementation. Search existing issues. Record the root problem once, with file/function, effect, severity, reproduction, and proper fix. Link the issue, then delete the comment.
- Stale: contradicts the current implementation or refers to removed behavior. Delete.
- Decision Record: preserves a non-obvious technical decision or trade-off. Create or update a matching ADR under docs/adr/ with status, context, decision, alternatives if known, consequences, paths, and issue/PR links. Delete only after recording the reason.

Preserve mandatory comments outside those four removal categories. Do not invent a reason for a decision. If the historical context is unknown, identify the uncertainty in the ADR. If a comment cannot be classified from available code, leave it unchanged and report it as pending review. Do not label guesses as verified classifications.

## Apply one review batch

1. Record current token count, comment-only lines, inline-comment lines, and physical source lines.
2. Select a small, related group of comments. Review source and tests. Prefer safe comment-only line removal.
3. For every Excuse, create or reuse its issue before deletion. For every Decision Record, create or update its ADR before deletion.
4. Remove only inspected comment tokens. Do not change runtime code, test assertions, imports, generated assets, or tool directives.
5. Run the comment checker before and after removal.
6. Run the shrink command; it cannot increase the baseline or accept replacement comments.
7. Inspect the diff to confirm only reviewed comments and planned ADRs, issues, skill, baseline, or CI changes were made.
8. Run relevant syntax checks, tests, package validation, and CI. Keep release work separate.
9. Commit a reviewable batch and update the PR with before-and-after counts and linked issues/ADRs.

Do not silently repair complex debt during comment removal. Verify that an issue still describes an actual problem before creating it. Never create duplicate issues or ADRs for the same root cause. If the batch was already applied, do nothing.

## Nexus-specific generated output

The exact files jev-browse/bundled/cli.mjs and jev-browse/bundled/mcp.mjs are esbuild output from source not present in the GitHub mirror. Their source-location comments are generated. Review or remove those comments in the canonical generator source or build configuration, never by editing the bundles manually. This exception does not apply to other paths.

## Verify and report

Report inspected, classified, deleted, protected, and pending comment counts separately. Distinguish token counts from comment-only physical lines and inline-comment lines. Report actual source-line changes from git diff rather than treating inline-comment removal as a full line removed. Compare with the pinned starting commit.

Include new issues, ADRs, blocked work, local test results, CI results, and the next review batch. Preserve each repository's independent baseline and history. Stop before a release or merge unless the repository's explicit release gate allows it.
