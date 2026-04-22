import os from 'os';
import path from 'path';

import { RgbVec } from './modules/graphics';

import pkg from '../package.json';
import { inferBool } from './utils/utilities';

const exeBasename = path.basename(process.argv[0] || 'gdx', path.extname(process.argv[0] || ''));

export const EXECUTABLE_NAME =
   exeBasename.startsWith('bun') || exeBasename.startsWith('node') ? 'gdx' : exeBasename;
export const TEMP_DIR = process.env.GDX_TEMP_DIR || os.tmpdir();
export const CURRENT_DIR = process.env.GDX_CURRENT_DIR || process.cwd();
export const CONFIG_FILE_NAME = '.gdxrc.toml';
export const CONFIG_DIR = path.join(os.homedir(), '.gdx');
export const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE_NAME);
export const LOG_PATH = path.join(TEMP_DIR, 'gdx', 'gdx.log');
export const LEGACY_CONFIG_PATH = path.join(os.homedir(), CONFIG_FILE_NAME);
export const GDX_CACHE_SCHEMA_VERSION = 1; // Increment this if there are breaking changes to the cache structure
export const GIT_DIR_NAME = '.git';
export const GDX_SIGNAL_CODE = 150;
export const GDX_RESULT_FILE = process.env.GDX_RESULT;
export const VERSION = pkg.version || 'unknown';
export const REPO_README_URL = pkg.homepage || '';
export const SHOULD_WRITE_LOGS =
   process.env.GDX_WRITE_LOGS != null ? inferBool(process.env.GDX_WRITE_LOGS) : true;

export const KEYCHAIN_SERVICE = 'gdx-cli';
export const SECURE_CONF_KEYS = ['llm.apiKey'];
export const CACHE_FILE_NAME = 'cache.json';
export const MACRO_FILE_NAME = 'macro.json';
export const TUI_THEME = 'catppuccin-mocha'; // TUI theme, can not be overwritten by anthing, Im lazy :)

/**
 * GDX color palette
 *
 * palette taken from https://tailwindcss.com/docs/colors
 */
export const GDX_VPALETTE = {
   OceanDeepBlue: [46, 149, 153],
   OceanGreen: [57, 211, 83],
   ForestGreen: [34, 139, 34],
   SunsetOrange: [255, 99, 71],
   MidnightBlack: [10, 16, 36],
   Zinc700: [63, 63, 70],
   Zinc500: [113, 113, 122],
   Zinc400: [161, 161, 170],
   Zinc100: [244, 244, 245],
   Zinc050: [250, 250, 250],
   Fuchsia400: [232, 121, 249],
   Teal300: [94, 234, 212],
} as const satisfies Record<string, RgbVec>;

/**
 * Catppuccin Mocha color palette for TUI theming
 */
export const CATPPUCCIN_VPALETTE = {
   base: [30, 30, 46],
   mantle: [24, 24, 37],
   crust: [17, 17, 27],
   surface0: [49, 50, 68],
   surface1: [69, 71, 90],
   overlay0: [147, 153, 178],
   overlay1: [127, 132, 156],
   text: [205, 214, 244],
   green: [166, 227, 161],
   red: [243, 139, 168],
   yellow: [249, 226, 175],
   blue: [137, 180, 250],
   cyan: [148, 226, 213],
   lavender: [180, 190, 254],
} as const satisfies Record<string, RgbVec>;

// from unicode-animations package. value prerendered for performance
export const DEFAULT_SPINNER: readonly string[] = [
   '⠁⠀',
   '⠋⠀',
   '⠟⠁',
   '⡿⠋',
   '⣿⠟',
   '⣿⡿',
   '⣿⣿',
   '⣿⣿',
   '⣾⣿',
   '⣴⣿',
   '⣠⣾',
   '⢀⣴',
   '⠀⣠',
   '⠀⢀',
   '⠀⠀',
   '⠀⠀',
   '⠀⠀',
   '⠀⠀',
   '⠀⠀',
   '⠀⠀',
];

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
];

// Source of Truth
export const ONE_DAY_MS = 1000 * 60 * 60 * 24;
export const CACHE_PATH = path.join(TEMP_DIR, 'gdx', CACHE_FILE_NAME);
export const MACRO_PATH = path.join(CONFIG_DIR, MACRO_FILE_NAME);
export const DEFAULT_CACHE_MAX_AGE = 360; // Expire cache after 6 hours (unit in minutes)
export const CACHE_PRUNE_INTERVAL_DAYS = 7; // Prune expired keys every 7 days
export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
export const LOG_FILE_SIZE_LIMIT = 500 * 1024; // 500 KB

export const GDX_COMMANDS = [
   // original git commands
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
   'submodule',
   'tag',
   'fetch',
   'remote',
   'show',
   'config',
   // gdx custom commands
   'parallel',
   'nocap',
   // 'stats',
   'clear',
   'reword',
   'gdx-config',
   'graph',
   'macro',
   'cache',
   'doctor',
];

export const GDX_SHORTHANDS = [
   's', // status
   'st', // status (another variant)
   'co', // checkout
   'br', // branch
   'cmi', // commit
   'mg', // merge
   'pl', // pull
   'pu', // pull (another variant)
   'ps', // push
   'ad', // add
   'rv', // revert
   'rb', // rebase
   'lg', // log
   'sta', // stash
] as const;

export const GDX_GLOBAL_FLAGS = ['--loglevel', '--ghelp', '--bypass', '--no-enhance'] as const;

export const GDX_OPTIONS_WITH_VALUES = ['--loglevel', '--init', '--shell', '--cmd'] as const;
export const GDX_OPTIONS_NO_VALUES = ['--ghelp', '--bypass', '--no-enhance', '-gh'] as const;

// Git stuff
export const GIT_GLOBAL_OPTIONS_WITH_VALUES = [
   '-C',
   '-c',
   '--git-dir',
   '--work-tree',
   '--namespace',
   '--config-env',
] as const;
export const GIT_GLOBAL_OPTIONS_NO_VALUES = [
   '--no-pager',
   '--no-optional-locks',
   '--literal-pathspecs',
   '--glob-pathspecs',
   '--noglob-pathspecs',
   '--icase-pathspecs',
] as const;
/**
 * The list of files that git sometimes missinterprets as text and tries to diff, but are actually binary.
 */
export const KNOWN_GIT_FAULT_FILE_HUBRISTICS = [
   '.pdf',
   '.doc',
   '.docx',
   '.zip',
   '.tar',
   '.png',
   '.jpg',
   '.jpeg',
   '.gif',
]

// Language catalog constants
export const LANGUAGE_SOURCE_URL =
   'https://github.com/github-linguist/linguist/raw/refs/heads/main/lib/linguist/languages.yml';
export const LANGUAGE_CACHE_KEY = 'languages.catalog';
export const LANGUAGE_REFRESH_INTERVAL_MS = ONE_DAY_MS * 7; // Refresh every 7 days
export const LANGUAGE_FETCH_TIMEOUT_MS = 4000;
export const LANGUAGE_WHITELIST = [163, 222, 407, 337, 51, 174, 365, 88, 80];

// Diff viewer constants
export const INLINE_DIFF_MERGE_DISTANCE = 7;

// Commit guideline learning constants
export const COMMIT_HEADER_SAMPLE_LIMIT = 50;
export const COMMIT_MEDOID_SAMPLE_LIMIT = 25;
export const COMMIT_EXAMPLE_LIMIT = 10;
export const COMMIT_HEADER_PREFIX_LENGTH = 28;
