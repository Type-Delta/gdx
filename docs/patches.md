# 3rd Party Package Patches

### `tty-strings` @1.5.2

This patch exposes `wrapLine()` and changes its return type to `string[]` instead of a single string.
This allows us to write our own version of `wordWrap()`.
