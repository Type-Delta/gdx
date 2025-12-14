import path from "path";

const exeBasename = path.basename(process.argv[0] || "gdx")

export const EXECUTABLE_NAME = exeBasename.startsWith("bun") ? "gdx" : exeBasename;
export const VERSION = "0.0.1";
export const COMMON_GIT_CMDS = [
   'add',
   'branch',
   'checkout',
   'clone',
   'commit',
   'diff',
   'log',
   'pull',
   'push',
   'rebase',
   'reset',
   'revert',
   'merge',
   'init',
   'stash',
   'status',
   'switch',
];


