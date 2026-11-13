# File, content, and disk search research

Researched 12 November 2026. These are different workloads and need separate measurements.

UFFS 0.6.47 was installed and tried on the owner's laptop on 12 November 2026, using its UffsAccessBroker Windows service for non-elevated searches. The shared harness find_files tool passed a folder lookup in 0.45 seconds end to end (0.44 seconds in the UFFS subprocess), and an optional Jev-ranked ZIP lookup in 1.03 seconds (0.39 seconds in the UFFS subprocess). These are warm indexed lookups on C:. They are not WizTree comparative benchmarks or complete-disk scans. UFFS therefore now has an operational adapter in addition to its earlier research-candidate status.

| Work | First choice | Role for Jev |
|---|---|---|
| Text in code/config/logs | ripgrep JSON output, scoped and bounded | Select a relevant excerpt from actual matches |
| File names and metadata | Everything ES/SDK | Rank returned paths and select a search refinement |
| PDF/DOCX content | ripgrep-all adapters and extraction cache | Rank passages after extraction |
| Largest folders/files | WizTree CLI CSV export | Explain and prioritize observed disk usage |
| Alternative metadata backend | Benchmark UFFS against Everything and WizTree | Same candidate-ranking interface |

The first content-search adapter is implemented as jev_search_content. It accepts an explicit folder root, literal pattern and natural-language query. ripgrep reads local files and emits JSON. At most 24 excerpts of 600 characters are offered to Jev. The tool reports truncation, file paths and line numbers. No match requires no Jev call. A timeout or result cap must not be presented as an exhaustive result. Candidate excerpts leave the machine for TypeSafe ranking.

Everything searches indexed file metadata quickly, but its documented content search reads files on demand and can be slow. Start with name/path/date/size filters before content scanning. ES has a database-ready timeout: an empty answer before the database loads must not be interpreted as no files.

WizTree provides documented command-line CSV exports and MFT-based scans. Business use requires a site supporter code under its EULA. Do not bundle its binaries or assume a business license. Compare logical size, allocated size, hard-link treatment, inaccessible files and junction handling when evaluating disk scanners.

UFFS is an open-source Windows NTFS MFT search engine with CLI, MCP, daemon and broker. Its published end-to-end benchmarks are author measurements against Everything on a particular machine. They do not prove speed parity with WizTree on this laptop. Its broker/daemon adds infrastructure, so qualify it before installing alongside Everything.

Benchmark on the same local NTFS volume with identical scope and output limits. Measure process startup, cold scan, warm queries, top largest folders, complete export time, idle CPU/memory, and freshness after a file change. Network shares require a separate test because raw local MFT access is unavailable there.

Sources checked:

- https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md
- https://www.voidtools.com/support/everything/command_line_interface/
- https://www.voidtools.com/support/everything/searching/
- https://diskanalyzer.com/guide
- https://diskanalyzer.com/eula
- https://github.com/skyllc-ai/UltraFastFileSearch
- https://github.com/skyllc-ai/UltraFastFileSearch/blob/main/docs/user-manual/performance.md
- https://github.com/phiresky/ripgrep-all
