# gdx (Git Developer Experience)

**The git CLI wrapper that treats you like a human, not a compiler.**

![License](https://img.shields.io/badge/license-MIT-blue.svg) ![Status](https://img.shields.io/badge/status-experimental-orange.svg)

> [!WARNING]
> **⚠️ ALPHA WARNING:** This project is currently in a "trial phase" (i.e., I'm dogfooding it daily). Expect breaking changes, missing features, and the occasional hiccup.

---

## What is gdx?

`gdx` is a drop-in wrapper for the Git CLI. It doesn't replace Git; it just makes it less... unpleasant.

It wraps standard git commands with intelligent shorthands and adds powerful new capabilities that Git is missing like safety rails for destructive actions (undoable `reset --hard`), introduces new workflows for parallel editing and local analytics.

**Why gdx?**

- **👍 Convenience:** Type less, do more. `git status`? how about `gdx s`?, `git reset HEAD~3`? why not `gdx res ~3`?
- **🛡️ Safety:** `gdx clear` wipes your directory but saves a backup patch. No more "oops" moments.
- **🧠 Logic:** Handles the things Git makes hard, like dropping a range of stashes (`drop 2..6`).
- **📊 Local-First Stats:** Beautiful TrueColor graphs and stats generated from your local history.
- **🤖 AI Integration:** Generate commit messages and roast your history with local or cloud LLMs.

## Installation

<details expanded>
<summary><strong>With NPM</strong></summary>

### Default (Recommended)

Uses the bundled JS version. Works everywhere Node.js 18+ is installed.
This is the easiest way to get started and ensures maximum compatibility.

```bash
npm i -g gdx
```

### Prebuilt Binary

Downloads a precompiled native binary. No runtime dependency on Node/Bun for execution.

```bash
GDX_USE_PREBUILT=1 npm i -g gdx # bash / zsh
# or
$env:GDX_USE_PREBUILT='1'; npm i -g gdx # powershell / fish
```

### Build Locally

Compiles a native binary on your machine during install. Requires [Bun](https://bun.sh) to be installed.

```bash
GDX_BUILD_NATIVE=1 npm i -g gdx # bash / zsh
# or
$env:GDX_BUILD_NATIVE='1'; npm i -g gdx # powershell / fish
```

> [!NOTE] If your environment sets `ignore-scripts=true`, the installation will succeed but default to the Node.js fallback.
> Run `gdx doctor` to verify your installation status.

</details>

<details>
<summary><strong>Download Manually</strong></summary>

Prebuilt stand-alone binaries are available on the [Releases](https://github.com/Type-Delta/gdx/releases/download) page.

</details>

<details>
<summary><strong>Build it yourself</strong></summary>

Requires [Bun](https://bun.sh) to be installed.

```bash
git clone https://github.com/Type-Delta/gdx.git --depth 1
cd gdx
bun install
bun run build
```

Your compiled binary will be in `./dist/` folder.

</details>

### Optional: Shell Integration

To enable features like `gdx parallel switch` (auto-cd into worktrees) and **tab completion**, you need to add shell integration.

Shell integration provides:

- **Auto-cd support**: Allows `gdx parallel switch` to change directories
- **Tab completion**: Intelligent completion for gdx commands, shorthands, and git subcommands
- **Completion fallback**: Falls back to native git completion when gdx has no suggestions (git fallback requires you to install git's completion scripts separately)

To add shell integration, add the following line to the **End** of your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):

#### For bash and zsh:

```bash
eval "$(gdx --init bash)"  # for bash
eval "$(gdx --init zsh)"   # for zsh
```

#### For fish:

```fish
gdx --init fish | source
```

#### For PowerShell:

To find your profile path, run `$PROFILE` in PowerShell.

```powershell
Invoke-Expression (& { (gdx --init pwsh | Out-String) })
```

> [!TIP]
> You can add `--cmd` to the `gdx --init` command to create custom aliases.
> For example, `gdx --init zsh --cmd g` will create `g` as an alias for `gdx`.

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
>
> If GDX still gets in your way, just run `gdx --bypass <git-commands>` to skip gdx intervention altogether.

### 2. Smart Linting

Catch issues before they reach the remote. `gdx lint` checks for:

- Spelling errors in commit messages
- Conflict markers left in code
- Sensitive content (keys, tokens)
- Large files

You can configure `gdx` to run this automatically before every push.

### 3. The Safety Net: `clear` vs `reset`

We've all accidentally reset files we meant to keep. `gdx clear` is the solution.

- **`gdx clear`**: Creates a timestamped patch backup in a temp folder, then effectively runs `reset --hard` & `clean -fd`.
- **`gdx clear pardon`**: "Wait, I didn't mean to do that." Applies the backup patch and restores your changes.

### 4. Parallel Worktrees (Experimental)

Need to work on the **same branch** in multiple isolated environments without checking out new branches?

```bash
# Manage forked worktrees for the current branch
gdx parallel fork    # Create a new temp-backed fork
gdx parallel list    # See where your forks are
gdx parallel switch  # Switch between forks (requires shell integration)
gdx parallel open    # Open any fork in your default editor
gdx parallel join    # Merge changes from a fork back to main
gdx parallel sync    # Sync forks with the main (origin worktree)
gdx parallel pick    # Cherry-pick a commit from between forks
gdx parallel remove  # Remove a fork when you're done
```

Additionally, `gdx parallel fork` can auto-initialize submodules and
install dependencies using detected package managers (currently supports npm, pnpm, bun, and uv)
if configured (see `parallel.init` config for options),
getting the fork ready for work in no time.

### 5. Git Output for Human (Experimental)

Admit it, Git's default output isn't exactly designed for readability.
`gdx` enhances the output of some commands with better formatting to make it less "git" to read.

Currently, we only support enhanced formatting for `gdx diff` and `gdx show`,
but more commands will be added in the future. (feel free to request what commands you'd like to see enhanced!)

#### Example: `gdx diff`

![diff example](https://github.com/Type-Delta/gdx/raw/main/resources/images/gdx-diff-enhance.png)

> [!NOTE]
> The enhanced output is only enabled when the output is TTY (i.e., in the terminal) plus other conditions based on the command (e.g., `diff` must be run without `--name-only`).
> If you pipe the output to a file or another command, it will fall back to the standard Git output.
>
> If you want to disable the enhanced output altogether, you can set `enhancedOutput` to `false` in the config.

### 6. Advanced Stash Management

Git stash is great until you need to clean it up.

```bash
gdx sta l           # git stash list
gdx sta drop 2..6   # Drops stashes 2 through 6.
                    # (Drops high->low to prevent index shifting)
gdx stash d pardon  # Restores the last dropped stash.
```

### 7. Commits Message Generation

Struggling to come up with a commit message? Let `gdx` do it for you.

```bash
gdx commit auto   # Generates a commit message based on staged changes, then commits them.
# or
# Generates a commit message based on staged changes, but does not commit them.
# `--copy` also copies the message to clipboard.
gdx cmi auto --no-commit --copy
# You can also configure which LLM to use with `gdx-config`
```

### 8. Fun & Analytics

Tools to help you feel productive without leaving the terminal.

- **`gdx stats`**: Shows fun contribution statistics and metrics for your current repo.
- **`gdx graph`**: Renders a GitHub-style contribution heatmap in your terminal using TrueColor.
- **`gdx nocap`**: Uses AI to roast your latest commit message.

#### Example: `gdx stats`

![stats example](https://github.com/Type-Delta/gdx/raw/main/resources/images/gdx-stats.png)

## Command Reference

| Command           | Expansion / Function                                               |
| :---------------- | :----------------------------------------------------------------- |
| `s`, `stat`       | `git status` (use `-r` recursively run "status" on all submodules) |
| `lg`, `lo`        | `git log --oneline --graph --all --decorate`                       |
| `sw`, `swit`      | `git switch`                                                       |
| `br`, `bra`       | `git branch`                                                       |
| `cmi`, `com`      | `git commit` (Try `gdx cmi auto` for AI messages!)                 |
| `res`             | `git reset` (supports `res ~3`, `res -h` expansion)                |
| `dif`             | `git diff` (supports `dif ~3`, `dif origin ~2` expansion)          |
| `sho`             | `git show` (supports `sho ~3`, `sho origin ~2` expansion)          |
| `sta`, `st`       | `git stash`                                                        |
| `lint`            | Run pre-push checks (spelling, secrets, etc.)                      |
| `gdx-config`      | Manage gdx configuration                                           |
| `reword`, `rew`   | Rewrite commit messages                                            |
| `parallel`, `par` | Manage parallel worktrees for the current branch                   |
| `stats`           | Show contribution statistics and metrics for the current repo      |
| `graph`           | Render a GitHub-style contribution heatmap in the terminal         |
| `nocap`           | Roast your latest commit message with AI                           |
| `clear`           | Wipe changes in the working directory with a backup patch          |
| `cache`           | Manage gdx cache                                                   |

_Run `gdx ghelp` to see the full list of expansions._

## Development

This project uses **Bun** for development because it's fast and the developer experience is great.

1. Clone the repo
2. Prepare the development environment:
   ```bash
   bun run prepare-dev
   ```
3. Run in dev mode:

   ```bash
   bun start -- # your gdx commands here

   # for example:
   bun start -- s # runs `gdx s` (git status)
   ```

## Roadmap

Since this is currently a solo "scratch your own itch" project, the roadmap is fluid, but here is what is on the horizon:

- [x] **Configurability:** Allow users to define their own shorthands in a `.gdxrc.toml` file (default: `~/.gdx/.gdxrc.toml`).
- [x] **Shell Integration:** Auto-completion scripts for Zsh/Bash/Fish/Powershell with git fallback.
- [x] **Quick linting before push:** `gdx lint` to run following checks before pushing:
   - commit message spelling
   - env or sensitive content scanning
   - conflict markers
   - abnormal file sizes
     with an option to automatically run lint before every push (bypass with `gdx push --no-lint`)
- [x] **Undoable stash drop**
- [x] **Parallel worktree switching** `gdx parallel switch` Jump between forks (auto-cd) (requires shell integration with `gdx --init`)
- [ ] **Seamless Integration with fzf and cloc**
      automatically detect and use fzf and/or cloc if installed for:
   - Interactive fuzzy search for branches, commits, stash, log and files instead of `less`
   - Code line statistics in `gdx stats` using `cloc`
- [x] **gdx clear Untracked files support**: `gdx clear` now automatically backs up untracked files in the patch.
- [x] **Recursive status for submodules** with `gdx status --recursive` or `gdx s -r`
- [x] **Submodule dir switching**: extension of `git submodule`, `gdx submodule switch` to jump into a submodule's directory from the parent repo (requires shell integration)
- [ ] **Snapshot**: `gdx snap` to create snapshot of current state of your working directory (including uncommitted changes, untracked files) that can be easily switched back to later (similar to a lightweight, temporary branch that doesn't clutter your branch list)
- [ ] **Enhanced output for more commands**: Extend the "Git Output for Humans"
- [ ] **Undo and Redo**: `gdx undo` and `gdx redo` to step backward and forward through git actions (reset, commit, stash, etc.) with safety nets.
- [ ] **Edit commit history**: `gdx hist` for an intuitive interface to amend, reorder, squash commits without needing to remember complex rebase commands.
- [x] **Edit commit messages**: `gdx reword` to quickly reword the last commit message or a specific commit without needing to do an interactive rebase.

## License

MIT © Type-Delta
