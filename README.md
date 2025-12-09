# gdx (Git Developer Experience)

**The CLI wrapper that treats you like a human, not a compiler.**

![License](https://img.shields.io/badge/license-MIT-blue.svg) ![Status](https://img.shields.io/badge/status-experimental-orange.svg)

> [!WARNING]
> **⚠️ PRE-ALPHA WARNING:** This project is currently in a "trial phase" (i.e., I'm dogfooding it daily). Expect breaking changes, missing features, and the occasional hiccup. Use with curiosity!

---

## What is gdx?

`gdx` is a drop-in wrapper for the Git CLI. It doesn't replace Git; it just makes it less... unpleasant.

It wraps standard git commands with intelligent shorthands and adds powerful new capabilities that Git is missing like safety rails for destructive actions (undoable `reset --hard`), introduces new workflows for parallel editing and local analytics.

**Why gdx?**

- **⚡ Speed:** Type less. `gdx s` is `status`. `gdx sta l` is `stash list`.
- **🛡️ Safety:** `gdx clear` wipes your directory but saves a backup patch. No more "oops" moments.
- **🧠 Logic:** Handles the things Git makes hard, like dropping a range of stashes (`drop 2..6`) without index shifting errors.
- **📊 Local-First Stats:** Beautiful TrueColor graphs and stats generated from your local history.

## Installation

> _Installation instructions coming soon!_

<!-- **Requirements:**

- Node.js (LTS recommended)
- Git

```bash
npm install -g gdx
``` -->

## Core Features

### 1. Intelligent Shorthands

`gdx` isn't just a list of static aliases. It understands partial commands and expands them smartly.

```bash
gdx s             # -> git status
gdx lg            # -> git log --oneline --graph --all --decorate
gdx pl -au        # -> git pull --allow-unrelated-histories
gdx ps -fl        # -> git push --force-with-lease
```

> [!NOTE]
> This wrapper forwards unrecognized commands directly to `git`, so you can use it as your daily driver.

### 2. The Safety Net: `clear` vs `reset`

We've all accidentally reset files we meant to keep. `gdx clear` is the solution.

- **`gdx clear`**: Creates a timestamped patch backup in a temp folder, then effectively runs `reset --hard` & `clean -fd`.
- **`gdx clear pardon`**: "Wait, I didn't mean to do that." Applies the backup patch and restores your changes.

### 3. Parallel Worktrees (Experimental)

Need to work on the **same branch** in multiple isolated environments without checking out new branches?

```bash
# Manage forked worktrees for the current branch
gdx parallel fork    # Create a new temp-backed fork
gdx parallel list    # See where your forks are
gdx parallel switch  # Jump between forks (auto-cd)
gdx parallel join    # Merge changes from a fork back to main
```

### 4. Advanced Stash Management

Git stash is great until you need to clean it up.

```bash
gdx sta l           # git stash list
gdx sta d 2..6      # Drops stashes 2 through 6.
                    # (Smartly drops high->low to prevent index shifting!)
```

### 5. Fun & Analytics (Local Only)

Tools to help you feel productive without leaving the terminal. None of this data leaves your machine.

- **`gdx stats`**: Shows fun contribution statistics and metrics for your current repo.
- **`gdx graph`**: Renders a GitHub-style contribution heatmap in your terminal using TrueColor.
- **`gdx nocap`**: Uses AI to roast your latest commit message. Keeps your repo clean (read-only).

## Command Reference

| Command      | Expansion / Function                               |
| :----------- | :------------------------------------------------- |
| `s`, `stat`  | `git status`                                       |
| `lg`, `lo`   | `git log --oneline --graph --all --decorate`       |
| `sw`, `swit` | `git switch`                                       |
| `br`, `bra`  | `git branch`                                       |
| `cmi`, `com` | `git commit` (Try `gdx cmi auto` for AI messages!) |
| `res`        | `git reset` (supports `res ~3` expansion)          |
| `sta`, `st`  | `git stash`                                        |

_Run `gdx help` to see the full list of expansions._

## Development

This project uses **Bun** for development because it's fast and the developer experience is great.

1. Clone the repo
2. Install dependencies:
   ```bash
   bun install
   ```
3. Run in dev mode:

   ```bash
   bun start -- # your gdx commands here

   # for example:
   bun start -- s # runs `gdx s` (git status)
   ```

## Roadmap

Since this is currently a solo "scratch your own itch" project, the roadmap is fluid, but here is what is on the horizon:

- [ ] **Configurability:** Allow users to define their own shorthands in a `.gdxrc` file.
- [ ] **Shell Integration:** Auto-completion scripts for Zsh/Bash/Fish.

## License

MIT © Type-Delta
