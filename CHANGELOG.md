# Changelog

## [Unreleased]

### Added

- recursive status for submodules with `gdx status --recursive` or `gdx s -r`.
- improved commit auto with "inherit" mode, which learns commit message patterns from repository history.

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
