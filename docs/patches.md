# 3rd Party Package Patches

### `tty-strings` @1.5.2

This patch exposes `wrapLine()` and changes its return type to `string[]` instead of a single string.
This allows us to write our own version of `wordWrap()`.

### `execa` @9.6.1

Bundle-size patch (`patches/execa@9.6.1.patch`). gdx only ever calls the **async**
execa methods (`execa`, the `$` template, `execaNode` is unused, etc.); the synchronous
methods (`execaSync`, `execaCommandSync`, `$.sync`) are never used.

In `lib/methods/create.js`, execa statically imports both `execaCoreSync` (`main-sync.js`)
and `execaCoreAsync` (`main-async.js`) and dispatches on an `isSync` flag. Because the
async-only `execa` keeps a static reference to `main-sync.js`, the bundler cannot
tree-shake the entire synchronous subtree (`main-sync`, `handle-sync`, `output-sync`,
`input-sync`, `all-sync`, `exit-sync`, `run-sync`, …). The patch drops the `execaCoreSync`
import and the `isSync` branch so the async core is always taken, making that subtree
unreachable and tree-shakeable.

> [!WARNING]
> Side effect: the still-exported `execaSync`/`*Sync` methods would now run **async**
> (returning a promise) instead of throwing/blocking. This is safe only because gdx never
> imports them and they are tree-shaken out of the production bundle. If a sync method is
> ever needed, drop this patch instead of relying on those exports.
