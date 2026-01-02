import path from 'path';
import os from 'os';

import { RgbVec } from './utils/graphics';

import pkg from '../package.json';

const exeBasename = path.basename(process.argv[0] || 'gdx', path.extname(process.argv[0] || ''));

export const EXECUTABLE_NAME = exeBasename.startsWith('bun') ? 'gdx' : exeBasename;
export const TEMP_DIR = process.env.GDX_TEMP_DIR || os.tmpdir();
export const CURRENT_DIR = process.env.GDX_CURRENT_DIR || process.cwd();
export const CONFIG_FILE_NAME = '.gdxrc.toml';
export const CONFIG_PATH = path.join(os.homedir(), CONFIG_FILE_NAME);
export const GIT_DIR_NAME = '.git';
export const GDX_SIGNAL_CODE = 150;
export const GDX_RESULT_FILE = process.env.GDX_RESULT;
export const VERSION = pkg.version || 'unknown';

export const KEYCHAIN_SERVICE = 'gdx-cli';
export const SECURE_CONF_KEYS = ['llm.apiKey'];
export const COMMON_GIT_CMDS = [
   // For original git commands ONLY
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

// palette taken from https://tailwindcss.com/docs/colors
export const COLOR = {
   OceanDeepBlue: [46, 149, 153],
   OceanGreen: [57, 211, 83],
   ForestGreen: [34, 139, 34],
   SunsetOrange: [255, 99, 71],
   MidnightBlack: [10, 16, 36],
   Zinc700: [63, 63, 70],
   Zinc300: [212, 212, 216],
   Zinc100: [244, 244, 245],
   Fuchsia400: [232, 121, 249],
   Teal300: [94, 234, 212],
} as const satisfies Record<string, RgbVec>;

export const SPINNER: string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const STATS_EST = {
   AVG_CHARS_PER_LINE: 40,
   AVG_LINES_PER_FUNCTION: 45,
   AVG_LINES_PER_FILE: 500,
};

export const SENSITIVE_CONTENTS_REGEXES = [
   /api[\w_-]?key[\w_-]?\s*=\s*['"].+['"]/i,
   /access[\w_-]?token[\w_-]?\s*=\s*['"].+['"]/i,
   /private[\w_-]?key[\w_-]?\s*=\s*['"].+['"]/i,
   /sk-ant-[\d\w]{32,}/,
   /sk-[\d\w]{32,}/,
   /sk-or-[\d\w]{32,}/,
   /-----\s*BEGIN PRIVATE KEY\s*-----/i,
]

// Source of Truth
export const ONE_DAY_MS = 1000 * 60 * 60 * 24;
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
