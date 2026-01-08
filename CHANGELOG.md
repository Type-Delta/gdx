# Changelog

## [Unreleased]

### Fixed

- lint command failing to recognize many correct English words due to the absence of a dictionary file.

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
