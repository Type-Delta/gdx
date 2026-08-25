Git for Windows exposes `git.exe` from at least three directories — `Git\cmd\git.exe`,
`Git\bin\git.exe`, and `Git\mingw64\bin\git.exe` — and which one `whichExec('git')` picks
depends on **the PATH of the shell that launched the suite**, not on the machine:

- From PowerShell/CMD, PATH normally carries `C:\Program Files\Git\cmd`, so Git resolves
  to `Git\cmd\git.exe`.
- From Git Bash, MSYS rewrites PATH and puts `/mingw64/bin` (= `Git\mingw64\bin`, which
  also contains `git.exe`) near the front, so Git resolves to `Git\mingw64\bin\git.EXE`.
  The uppercase extension is the `which` package appending a PATHEXT entry verbatim.

Cached executable lookups are pinned to a fingerprint of `PATH`/`PATHEXT`
(`getWhichExecCached`), because checking that the cached file still exists is not enough —
every candidate `git.exe` stays on disk, so a stale entry would otherwise be returned
forever. Do not "optimize" that check back to existence-only.

Note also that `createTestEnv()` resolves Git **before** it mocks `@/consts`, so a cached
lookup there would read the developer's real global cache rather than the current run's
PATH. That call therefore passes `{ noCache: true }` deliberately.

A walk like `path.resolve(path.dirname(gitExe), '..', 'bin', 'sh.exe')` is only correct
for the `cmd\` layout; from `mingw64\bin\` it silently yields a non-existent
`Git\mingw64\bin\sh.exe`, surfacing as a cryptic
`'...sh.exe' is not recognized as an internal or external command`. The symptom is a suite
that passes from one terminal and fails from another, on the same commit. Use
`resolvePosixShell()` from `testHelper.ts`, which climbs ancestors probing for a shell
that actually exists and falls back to PATH.
