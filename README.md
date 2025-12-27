# gdx (Git Developer Experience)

**The git CLI wrapper that treats you like a human, not a compiler.**

![License](https://img.shields.io/badge/license-MIT-blue.svg) ![Status](https://img.shields.io/badge/status-experimental-orange.svg)

> [!WARNING]
> **⚠️ PRE-ALPHA WARNING:** This project is currently in a "trial phase" (i.e., I'm dogfooding it daily). Expect breaking changes, missing features, and the occasional hiccup.

---

## What is gdx?

`gdx` is a drop-in wrapper for the Git CLI. It doesn't replace Git; it just makes it less... unpleasant.

It wraps standard git commands with intelligent shorthands and adds powerful new capabilities that Git is missing like safety rails for destructive actions (undoable `reset --hard`), introduces new workflows for parallel editing and local analytics.

**Why gdx?**

- **⚡ Speed:** Type less. `gdx s` is `status`. `gdx sta l` is `stash list`.
- **🛡️ Safety:** `gdx clear` wipes your directory but saves a backup patch. No more "oops" moments.
- **🧠 Logic:** Handles the things Git makes hard, like dropping a range of stashes (`drop 2..6`) without index shifting errors.
- **📊 Local-First Stats:** Beautiful TrueColor graphs and stats generated from your local history.
- **🤖 AI Integration:** Generate commit messages and roast your history with local or cloud LLMs.

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
gdx lg export     # -> Exports git log to a markdown file
gdx pl -au        # -> git pull --allow-unrelated-histories
gdx ps -fl        # -> git push --force-with-lease
gdx reset ~2      # -> git reset HEAD~2
```

> [!NOTE]
> This wrapper forwards unrecognized commands directly to `git`, so you can use it as a full git replacement.

### 2. AI-Powered Commits

Struggling to write commit messages? Let `gdx` do it for you.

```bash
gdx commit auto   # Generates a commit message based on staged changes
```

### 3. Smart Linting

Catch issues before they reach the remote. `gdx lint` checks for:

- Spelling errors in commit messages
- Conflict markers left in code
- Sensitive content (keys, tokens)
- Large files

You can configure `gdx` to run this automatically before every push.

### 4. The Safety Net: `clear` vs `reset`

We've all accidentally reset files we meant to keep. `gdx clear` is the solution.

- **`gdx clear`**: Creates a timestamped patch backup in a temp folder, then effectively runs `reset --hard` & `clean -fd`.
- **`gdx clear pardon`**: "Wait, I didn't mean to do that." Applies the backup patch and restores your changes.

### 5. Parallel Worktrees (Experimental)

Need to work on the **same branch** in multiple isolated environments without checking out new branches?

```bash
# Manage forked worktrees for the current branch
gdx parallel fork    # Create a new temp-backed fork
gdx parallel list    # See where your forks are
gdx parallel open    # Open any fork in your default editor
gdx parallel join    # Merge changes from a fork back to main
```

### 6. Advanced Stash Management

Git stash is great until you need to clean it up.

```bash
gdx sta l           # git stash list
gdx sta d 2..6      # Drops stashes 2 through 6.
                    # (Smartly drops high->low to prevent index shifting!)
```

### 7. Fun & Analytics

Tools to help you feel productive without leaving the terminal.

- **`gdx stats`**: Shows fun contribution statistics and metrics for your current repo.
- **`gdx graph`**: Renders a GitHub-style contribution heatmap in your terminal using TrueColor.
- **`gdx nocap`**: Uses AI to roast your latest commit message.

## Command Reference

| Command      | Expansion / Function                                |
| :----------- | :-------------------------------------------------- |
| `s`, `stat`  | `git status`                                        |
| `lg`, `lo`   | `git log --oneline --graph --all --decorate`        |
| `sw`, `swit` | `git switch`                                        |
| `br`, `bra`  | `git branch`                                        |
| `cmi`, `com` | `git commit` (Try `gdx cmi auto` for AI messages!)  |
| `res`        | `git reset` (supports `res ~3`, `res -h` expansion) |
| `sta`, `st`  | `git stash`                                         |
| `lint`       | Run pre-push checks (spelling, secrets, etc.)       |
| `gdx-config` | Manage gdx configuration                            |

_Run `gdx ghelp` to see the full list of expansions._

## Development

This project uses **Bun** for development because it's fast and the developer experience is great.

1. Clone the repo
2. Prepare the development environment:
   ```bash
   bun prepare-dev
   ```
3. Run in dev mode:

   ```bash
   bun start -- # your gdx commands here

   # for example:
   bun start -- s # runs `gdx s` (git status)
   ```

## Roadmap

Since this is currently a solo "scratch your own itch" project, the roadmap is fluid, but here is what is on the horizon:

- [x] **Configurability:** Allow users to define their own shorthands in a `.gdxrc.toml` file.
- [ ] **Shell Integration:** Auto-completion scripts for Zsh/Bash/Fish/Powershell.
- [ ] **Commit with specified editor:** like, `gdx commit --vim` to open Vim for commit messages.
- [ ] **Quick commit:** `add`, `commit`, and `push` in one command like `gdx qc -pa` (`git add . && gdx commit auto && git push`)
- [x] **Quick linting before push:** `gdx lint` to run following checks before pushing:
   - commit message spelling
   - env or sensitive content scanning
   - conflict markers
   - abnormal file sizes
     with an option to automatically run lint before every push (bypass with `gdx push --no-lint`)
- [ ] **Undoable stash drop**
- [ ] **Parallel worktree switching** `gdx parallel switch` Jump between forks (auto-cd) (requires shell integration with `gdx --init --shell`)
- [ ] **Seamless Integration with fzf and cloc**
      automatically detect and use fzf and/or cloc if installed for:
   - Interactive fuzzy search for branches, commits, stash, log and files instead of `less`
   - Code line statistics in `gdx stats` using `cloc`

## License

MIT © Type-Delta
