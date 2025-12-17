import path from "path";
import { RgbVec } from "./utils/graphics";

const exeBasename = path.basename(process.argv[0] || "gdx")

export const EXECUTABLE_NAME = exeBasename.startsWith("bun") ? "gdx" : exeBasename;
export const VERSION = "0.0.1";

export const COMMON_GIT_CMDS = [ // For original git commands ONLY
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

export const COLOR: Record<string, RgbVec> = {
   OceanDeepBlue: [46, 149, 153],
   OceanGreen: [57, 211, 83],
   ForestGreen: [34, 139, 34],
   SunsetOrange: [255, 99, 71],
   MidnightBlack: [10, 16, 36],
}

export const STATS_EST = {
   AVG_CHARS_PER_LINE: 40,
   AVG_LINES_PER_FUNCTION: 45,
   AVG_LINES_PER_FILE: 500,
};


// Source of Truth
export const ONE_DAY_MS = 1000 * 60 * 60 * 24;

