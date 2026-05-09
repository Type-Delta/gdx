# Changelog

## [Unreleased]

### Added

- Medoid-based diverse commit sampling for guideline learning. This greatly improves learning for commit message generation.

### Fixed

- `gdx status --recursive` not properly handling git's arguments for submodule status.
- Optimized internal usage of `git config` to own implementation for better performance, especially on Windows where spawning git processes is expensive.

## Version 0.4.3 - 2026-04-19

### Added

- Improved reword command with better output, progress indication, with addition of diff showing message changes and list of rewritten commits.

### Fixed

- Fixed overflowing enhanced diff view with long lines.
- Improved 'modify' diff hunk rendering for better readability.
- Updated help messages accross app.
- `gdx clear pardon` failing to restore from patch file

## Version 0.4.2 - 2026-04-09

### Added

- `gdx tag mv` command for moving tags
- `stats --lang-metric` Language usage calculation modes (`auto`, `net`, `activity`) for controlling how line metrics are calculated in different scopes.
- Improved commit message generation with diff summarization with intelligent file categorization (normal/noisy/binary/rename) and hunk trimming. Added `--describe` flag for user-supplied change context, `--preview` to inspect LLM prompts without making requests.
- improved streaming output in commit and nocap commands.
- `submodule` inline submodule add, update, and deinit commands with full argument parsing, branch tracking, remote strategies, and configurable modes (native/internal).
- Improved submodule handling with in-flight request deduplication, submodule location cache with TTL, and HEAD-sensitive operation detection.
- `inline submodule mode` `useInlineSubmodule` configuration with `off`, `internal`, and `all` modes for controlling submodule handling.
- `character-level inline diff` Visual diff viewer with character-level highlighting for single-line replacements and per-character diff segments.
- ANSI style inference helper functions to extract and serialize ANSI styles for preserving colored text across line wraps in pager and diff-viewer.
- Object inventory statistics garbage object analysis using `git fsck` with total/garbage object counts and byte metrics in all-scope mode.
- Contributor detection: top contributor analysis in all-authors mode with contribution percentages, first commit timestamps, orphan commit counts, and hyperlinked repository/user profiles.
- `stats` binary file filtering with extension heuristics, filename-based language detection (e.g., Makefile), responsive terminal-aware formatting, and language whitelist support.
- `parallel sync/pick` Sync command for fork synchronization with merge/reset strategies, pick command for cherry-picking commits between worktrees, and enhanced join cursor blocking logic.
- `graph/stats --all` Project-wide analysis across all authors with language usage visualization and refactored JSTime parsing for improved performance.

### Changed

- Improved error messages and diagnostic output.
- `reword` Complete rewrite using `git commit-tree` instead of interactive rebase, eliminating sequence editor complexity and removing clean working tree requirements.
- `parallel -C handling` Proper `-C` argument routing using `getParallelScope` for correct dispatch behavior in fork and join commands.
- Replaced `git rev-list` with `git fsck` for more accurate unreachable commit detection.

### Fixed

- Conflict resolution and type formatting in language catalog.
- Bumped dependencies to latest compatible versions.

## Version 0.4.1 - 2026-03-02

### Added

- `gdx parallel join -i` interactive cherry-pick workflow with preview, undo support, cursor navigation, and skip options.
- Improved `gdx parallel fork` capabilities branch tracking, forking from a specific ref, environment file copying, and smarter origin-commit filtering.
- `gdx parallel remove -r` recursive worktree removal support.
- `gdx submodule switch` command.
- Progressive command matching/alias improvements for completion and subcommands.
- Git global option extraction/handling in argument parsing.
- `gdx commit auto --yes` for immediate, non-interactive commit confirmation.
- Cache runtime schema validation.
- Combined diff mode support in diff viewer.
- Spinner gradient interval control with prerendered frame usage.
- `--json` option for `gdx diff` and `gdx show` for structured output.
- `gdx reword` command for quick commit message editing without interactive rebase.

### Changed

- Refactored parallel join/rev-list/cursor internals for better maintainability and clearer conflict/status rendering.
- Improved visual feedback and spinner lifecycle behavior across parallel/git command flows.
- Enhanced doctor debug output and minor output formatting.
- Optimized text wrapping internals and `strWrap()` behavior/performance.

### Fixed

- Fixed parallel join edge cases in interactive conflict flows and cherry-pick skip behavior.
- Fixed exclusion logic to better avoid already-merged commits in parallel workflows.
- Fixed git command execution robustness with improved `--` separator usage and shell/execa error handling.
- Fixed ambiguous ref handling in stats commit counting.
- Fixed import-related runtime errors.
- Fixed test instability from parallel git process behavior.
- Fixed keytar module validation reliability.

## Version 0.4.0 - 2026-02-15

### Added

- macro support for `$*` syntax to insert all arguments to that position.
- enhanced Git's output features with more user-friendly formatting (experimental)
- relative ref expansions supports for `gdx diff` and `gdx show` commands.

### Fixed

- macro not properly append extra arguments
- improved system message formatting
- improve submodule support of `gdx parallel` command
- `gdx parallel join` failure from empty commit in cherry-pick operation.
- optimized `gdx parallel` command to reduce redundant operations and improve performance.

## Version 0.3.0 - 2026-02-05

### Added

- recursive status for submodules with `gdx status --recursive` or `gdx s -r`.
- improved commit auto with "inherit" mode, which learns commit message patterns from repository history.
- `gdx macro` command that allows users to define and run custom macros for repetitive git tasks.
- `--bypass` flag to completely skip gdx intervention for advanced users who want to run raw git commands.
- `gdx cache` command to manage cached data, including clearing and viewing cache status.
- command suggestions for available parallel aliases.
- `gdx parallel fork` worktree initialization automation, auto-initialize submodules and install dependencies using detected package managers.

### Fixed

- improved `gdx doctor` output & bug fixes for better diagnostics.
- minor performance improvements and bug fixes.
- improved caching mechanism with per-key TTLs.
- move default config location to `~/.gdx/*`.
- cspell not using default dictionary.

## Version 0.2.0 - 2026-01-14

### Added

- `gdx commit auto` now shows reasoning progress with a spinner and partial thinking output.
- caching mechanism for improved performance on repeated operations.
- `gdx stash` now automatically adds `push` or `save` when no subcommand is provided. This enables quick file specific stashing `gdx stash -- file1 file2` instead of needing to type `gdx stash push -- file1 file2`.
- shell integration now supports Tab completion.

### Fixed

- lint command failing to recognize many correct English words due to the absence of a dictionary file.
- optimized app startup time by lazy-loading non-essential modules and seperating code paths.

## Version 0.1.2 - 2026-01-07

### Added

- backup and restore of tracked files on `gdx clear` and `gdx clear pardon`
- `gdx stash drop pardon` to restore last dropped stash

### Changed

- help messages are now dynamically wrapped to terminal width

### Fixed

- Issue Node.js `fs/promises` missing some required methods and failing `parallel` command run on Node.js runtime
- NPM revival command in postinstall script

## Version 0.1.1 - 2026-01-03

### Fixed

- Bundled keytar failing to start on Linux and MacOS

## Version 0.1.0 - 2026-01-02

### Changed

- Startup performance optimizations

### Added

- `lint` command for pre-push checks
- `--init` command for shell integration setup
- `parallel switch` feature for auto-cd into worktrees
- Enhanced command expansions for better usability
- Documentation for installation and usage
- Release on NPM and GitHub Releases

## [Non-Release] Version 0.0.1

### Added

- `clear`, `stash drop`, `parallel`, `commit auto`, `stats`, `graph`, `nocap` commands
- command expansions for common git commands
