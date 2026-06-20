/**
 * Repository state that can be captured around a reversible action.
 */
export type HistoryDomain = 'refs' | 'index' | 'worktree' | 'untracked' | 'stash' | 'config';

/**
 * How the history dispatcher should treat an invocation.
 */
export type HistoryDisposition = 'no-history' | 'reversible' | 'audit-only' | 'unknown';

/**
 * State capture requested for a reversible action.
 */
export interface ReversibleCapturePlan {
   /** State domains that can be changed by the action. */
   domains: HistoryDomain[];
   /** Explicit pathspecs, or an empty array when the action is repository-wide. */
   pathspecs: string[];
   /** User-supplied flags that permit existing state to be overwritten. */
   overwriteFlags: string[];
   /** Whether the action can overwrite or discard existing state. */
   overwrites: boolean;
   /** Whether sequencer/merge and symbolic-HEAD state must be captured. */
   needsControlState: boolean;
}

/**
 * Pure classification result consumed by dispatch history capture.
 */
export interface HistoryActionClassification {
   /** Classification of the routed action. */
   disposition: HistoryDisposition;
   /** Canonical top-level route, or null when no route matched. */
   route: string | null;
   /** Stable action name including a meaningful mode or subcommand. */
   action: string | null;
   /** Redacted, normalized argv suitable for persistence. */
   normalizedArgv: string[];
   /** Redacted argv exactly as invoked, before route normalization. */
   originalArgv: string[];
   /** Redacted shell-readable form of originalArgv. */
   originalCommand: string;
   /** Non-null only for reversible actions; audit records must never be enriched. */
   capture: ReversibleCapturePlan | null;
}

const GDX_ROUTES = [
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
   'parallel',
   'nocap',
   'clear',
   'reword',
   'gdx-config',
   'graph',
   'history',
   'macro',
   'cache',
   'doctor',
   'snap',
   'gh',
] as const;

const ROUTE_ALIASES: Readonly<Record<string, string>> = {
   s: 'status',
   st: 'status',
   co: 'checkout',
   br: 'branch',
   cmi: 'commit',
   mg: 'merge',
   pl: 'pull',
   pu: 'pull',
   ps: 'push',
   ad: 'add',
   rv: 'revert',
   rb: 'rebase',
   rst: 'restore',
   lg: 'log',
   sta: 'stash',
};

const EXTRA_GIT_ROUTES = new Set([
   'am',
   'apply',
   'archive',
   'bisect',
   'blame',
   'bundle',
   'cat-file',
   'cherry',
   'cherry-pick',
   'clean',
   'count-objects',
   'credential',
   'describe',
   'difftool',
   'fast-export',
   'fast-import',
   'for-each-ref',
   'format-patch',
   'fsck',
   'gc',
   'grep',
   'hash-object',
   'help',
   'index-pack',
   'ls-files',
   'ls-remote',
   'ls-tree',
   'maintenance',
   'merge-base',
   'merge-tree',
   'mktag',
   'mktree',
   'name-rev',
   'notes',
   'prune',
   'prune-packed',
   'range-diff',
   'read-tree',
   'reflog',
   'remote-ext',
   'remote-fd',
   'replace',
   'request-pull',
   'restore',
   'rev-list',
   'rev-parse',
   'rm',
   'shortlog',
   'show-branch',
   'show-index',
   'show-ref',
   'sparse-checkout',
   'stage',
   'symbolic-ref',
   'unpack-file',
   'unpack-objects',
   'update-index',
   'update-ref',
   'var',
   'verify-commit',
   'verify-pack',
   'verify-tag',
   'version',
   'whatchanged',
   'worktree',
   'write-tree',
]);

const EXACT_CUSTOM_ROUTES = new Set(['__completion', 'gdx-help', 'ghelp', 'help', 'lint', 'stats']);

const ALWAYS_READ_ONLY = new Set([
   '__completion',
   'archive',
   'blame',
   'cat-file',
   'cherry',
   'count-objects',
   'describe',
   'diff',
   'difftool',
   'doctor',
   'fast-export',
   'for-each-ref',
   'format-patch',
   'fsck',
   'graph',
   'gdx-help',
   'ghelp',
   'grep',
   'help',
   'history',
   'lint',
   'log',
   'ls-files',
   'ls-remote',
   'ls-tree',
   'merge-base',
   'merge-tree',
   'name-rev',
   'nocap',
   'range-diff',
   'request-pull',
   'rev-list',
   'rev-parse',
   'shortlog',
   'show',
   'show-branch',
   'show-index',
   'show-ref',
   'stats',
   'status',
   'var',
   'verify-commit',
   'verify-pack',
   'verify-tag',
   'version',
   'whatchanged',
]);

const AUDIT_ONLY_ROUTES = new Set([
   'am',
   'apply',
   'bisect',
   'clone',
   'credential',
   'fast-import',
   'gc',
   'gh',
   'hash-object',
   'index-pack',
   'init',
   'maintenance',
   'mktag',
   'mktree',
   'notes',
   'prune',
   'prune-packed',
   'pull',
   'push',
   'read-tree',
   'remote-ext',
   'remote-fd',
   'replace',
   'reword',
   'sparse-checkout',
   'unpack-file',
   'unpack-objects',
   'update-index',
   'update-ref',
   'worktree',
   'write-tree',
]);

const SENSITIVE_OPTION =
   /(?:password|passwd|passphrase|token|secret|api[-_]?key|private[-_]?key|credential|authorization|oauth)/i;
const SENSITIVE_CONFIG_KEY =
   /(?:credential|password|passwd|passphrase|token|secret|api[-_]?key|private[-_]?key|extraheader|authorization|oauth)/i;
const REDACTED = '[REDACTED]';

const PATH_OPTION_VALUES = new Set([
   '-m',
   '--message',
   '-F',
   '--file',
   '--author',
   '--date',
   '--cleanup',
   '--fixup',
   '--squash',
   '--pathspec-from-file',
   '--source',
   '--conflict',
   '--recurse-submodules',
]);

/**
 * Returns the unique progressive match used by top-level dispatch.
 * @param input - User-provided route token.
 * @param candidates - Existing dispatch routes in dispatch order.
 * @returns Canonical route when exact or uniquely abbreviated.
 */
function uniqueRouteMatch(input: string, candidates: readonly string[]): string | null {
   const exact = candidates.find((candidate) => candidate === input);
   if (exact) return exact;
   const matches = candidates.filter((candidate) => candidate.startsWith(input));
   return matches.length === 1 ? matches[0] : null;
}

/**
 * Normalizes aliases and unique gdx route abbreviations without loading dispatch.
 * @param command - Top-level command token.
 * @returns Canonical route, or null when dispatch has no unambiguous known route.
 */
export function normalizeHistoryRoute(command: string | undefined): string | null {
   if (!command) return null;
   const input = command.toLowerCase();
   const alias = ROUTE_ALIASES[input];
   if (alias) return alias;
   const gdxRoute = uniqueRouteMatch(input, GDX_ROUTES);
   if (gdxRoute) return gdxRoute;
   if (EXACT_CUSTOM_ROUTES.has(input)) return input;
   return EXTRA_GIT_ROUTES.has(input) ? input : null;
}

/**
 * Redacts sensitive option and config values while preserving useful command shape.
 * @param argv - Command arguments to sanitize.
 * @returns A new redacted argv; the input is never mutated.
 */
export function redactHistoryArgv(argv: readonly string[]): string[] {
   const redacted = argv.slice();

   for (let index = 0; index < redacted.length; index++) {
      const argument = redacted[index];
      const equalsIndex = argument.indexOf('=');

      if (argument === '-c' && index + 1 < redacted.length) {
         redacted[index + 1] = redactConfigAssignment(redacted[index + 1]);
         index++;
         continue;
      }

      if (argument.startsWith('-c') && argument.length > 2) {
         redacted[index] = `-c${redactConfigAssignment(argument.slice(2))}`;
         continue;
      }

      if (equalsIndex > 0) {
         const option = argument.slice(0, equalsIndex);
         if (option.startsWith('-') && SENSITIVE_OPTION.test(option)) {
            redacted[index] = `${option}=${REDACTED}`;
         } else if (!option.startsWith('-') && SENSITIVE_CONFIG_KEY.test(option)) {
            redacted[index] = `${option}=${REDACTED}`;
         } else {
            redacted[index] = redactUrlCredentials(argument);
         }
         continue;
      }

      if (argument.startsWith('-') && SENSITIVE_OPTION.test(argument)) {
         if (index + 1 < redacted.length) {
            redacted[index + 1] = REDACTED;
            index++;
         }
         continue;
      }

      redacted[index] = redactUrlCredentials(argument);
   }

   const route = normalizeHistoryRoute(argv[0]);
   if ((route === 'config' || route === 'gdx-config') && redacted.length >= 3) {
      const positional = argv
         .map((value, index) => ({ value, index }))
         .filter(({ value, index }) => index > 0 && !value.startsWith('-'));
      const keyEntry = positional[0];
      const valueEntry = positional[1];
      if (keyEntry && valueEntry && SENSITIVE_CONFIG_KEY.test(keyEntry.value)) {
         redacted[valueEntry.index] = REDACTED;
      }
   }

   return redacted;
}

/**
 * Redacts the value portion of a git config assignment when its key is sensitive.
 * @param assignment - A `key=value` config assignment.
 * @returns Redacted assignment when needed.
 */
function redactConfigAssignment(assignment: string): string {
   const separator = assignment.indexOf('=');
   if (separator < 0) return SENSITIVE_CONFIG_KEY.test(assignment) ? REDACTED : assignment;
   const key = assignment.slice(0, separator);
   return SENSITIVE_CONFIG_KEY.test(key) ? `${key}=${REDACTED}` : assignment;
}

/**
 * Removes credentials embedded in an HTTP-style URL.
 * @param value - Possible URL argument.
 * @returns URL with user info redacted.
 */
function redactUrlCredentials(value: string): string {
   return value.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, `$1${REDACTED}@`);
}

/**
 * Formats redacted argv for audit display without invoking a shell.
 * @param argv - Already-redacted command arguments.
 * @returns Shell-readable command text.
 */
function formatCommand(argv: readonly string[]): string {
   return argv
      .map((argument) =>
         /^[\w./:@%+,=~-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`
      )
      .join(' ');
}

/**
 * Tests whether argv contains an exact long option or its equals form.
 * @param argv - Arguments to inspect.
 * @param options - Accepted option names.
 * @returns True when one of the options is present.
 */
function hasOption(argv: readonly string[], ...options: string[]): boolean {
   return argv.some((argument) =>
      options.some((option) => argument === option || argument.startsWith(`${option}=`))
   );
}

/**
 * Returns a normalized subcommand using priority matching where dispatch does so.
 * @param input - Subcommand token.
 * @param candidates - Candidates in priority order.
 * @param priority - Whether the first prefix match wins.
 * @returns Matched subcommand, or null.
 */
function normalizeSubcommand(
   input: string | undefined,
   candidates: readonly string[],
   priority = false
): string | null {
   if (!input || input.startsWith('-')) return null;
   const normalized = input.toLowerCase();
   const exact = candidates.find((candidate) => candidate === normalized);
   if (exact) return exact;
   const matches = candidates.filter((candidate) => candidate.startsWith(normalized));
   if (priority && matches.length > 0) return matches[0];
   return matches.length === 1 ? matches[0] : null;
}

/**
 * Extracts explicit pathspecs while skipping options with values.
 * @param argv - Full command argv.
 * @param start - First possible pathspec index.
 * @param includePositionals - Whether pre-terminator positionals are pathspecs.
 * @returns Extracted pathspecs in user order.
 */
function extractPathspecs(
   argv: readonly string[],
   start: number,
   includePositionals: boolean
): string[] {
   const separator = argv.indexOf('--', start);
   if (separator >= 0) return argv.slice(separator + 1);
   if (!includePositionals) return [];

   const pathspecs: string[] = [];
   for (let index = start; index < argv.length; index++) {
      const argument = argv[index];
      if (PATH_OPTION_VALUES.has(argument)) {
         index++;
      } else if (!argument.startsWith('-')) {
         pathspecs.push(argument);
      }
   }
   return pathspecs;
}

/**
 * Collects canonical overwrite flags relevant to one routed action.
 * @param route - Canonical route.
 * @param argv - Raw argv.
 * @returns Deduplicated canonical overwrite flags.
 */
function getOverwriteFlags(route: string, argv: readonly string[]): string[] {
   const flags: string[] = [];
   const add = (flag: string): void => {
      if (!flags.includes(flag)) flags.push(flag);
   };

   for (const argument of argv.slice(1)) {
      if (argument === '--force' || argument === '-f') add('--force');
      if (argument === '--hard' || (route === 'reset' && argument === '-h')) add('--hard');
      if (argument === '--discard-changes') add('--discard-changes');
      if (argument === '--overwrite-ignore') add('--overwrite-ignore');
      if (argument === '-B') add('-B');
      if (argument === '-C' && route === 'switch') add('-C');
      if (argument === '-D' && route === 'branch') add('-D');
      if (argument === '--amend' && route === 'commit') add('--amend');
      if (/^-[^-]*f/.test(argument) && route === 'clean') add('--force');
      if (/^-[^-]*x/.test(argument) && route === 'clean') add('-x');
      if (/^-[^-]*X/.test(argument) && route === 'clean') add('-X');
   }
   return flags;
}

/**
 * Creates the common reversible result payload.
 * @param base - Result fields shared by every disposition.
 * @param action - Stable action identifier.
 * @param domains - Affected repository domains.
 * @param pathspecs - Explicit targeted paths.
 * @param options - Capture behavior overrides.
 * @returns Reversible classification.
 */
function reversible(
   base: Omit<HistoryActionClassification, 'disposition' | 'action' | 'capture'>,
   action: string,
   domains: HistoryDomain[],
   pathspecs: string[] = [],
   options: { overwriteFlags?: string[]; overwrites?: boolean; control?: boolean } = {}
): HistoryActionClassification {
   const overwriteFlags = options.overwriteFlags || [];
   return {
      ...base,
      disposition: 'reversible',
      action,
      capture: {
         domains,
         pathspecs,
         overwriteFlags,
         overwrites: options.overwrites ?? overwriteFlags.length > 0,
         needsControlState: options.control ?? false,
      },
   };
}

/**
 * Creates a result that deliberately carries no enrichment plan.
 * @param base - Result fields shared by every disposition.
 * @param disposition - Non-reversible disposition.
 * @param action - Stable action identifier.
 * @returns Classification with a strictly null capture plan.
 */
function withoutCapture(
   base: Omit<HistoryActionClassification, 'disposition' | 'action' | 'capture'>,
   disposition: Exclude<HistoryDisposition, 'reversible'>,
   action: string | null
): HistoryActionClassification {
   return { ...base, disposition, action, capture: null };
}

/**
 * Determines whether branch argv is a non-mutating query.
 * @param argv - Branch command argv.
 * @returns True for branch listing/query forms.
 */
function isReadOnlyBranch(argv: readonly string[]): boolean {
   if (argv.length === 1) return true;
   if (
      hasOption(
         argv,
         '--show-current',
         '--list',
         '--contains',
         '--no-contains',
         '--merged',
         '--no-merged'
      )
   ) {
      return !hasOption(argv, '--create-reflog', '--edit-description');
   }
   const positionals = argv.slice(1).filter((argument) => !argument.startsWith('-'));
   return positionals.length === 0 && !hasOption(argv, '--edit-description');
}

/**
 * Determines whether tag argv is a non-mutating query.
 * @param argv - Tag command argv.
 * @returns True for tag listing and verification forms.
 */
function isReadOnlyTag(argv: readonly string[]): boolean {
   if (argv.length === 1) return true;
   return (
      hasOption(
         argv,
         '--list',
         '--verify',
         '--points-at',
         '--contains',
         '--merged',
         '--no-merged'
      ) ||
      argv.includes('-l') ||
      argv.includes('-v')
   );
}

/**
 * Determines whether config argv reads without writing configuration.
 * @param argv - Config command argv.
 * @returns True for read/list/get forms.
 */
function isReadOnlyConfig(argv: readonly string[]): boolean {
   const mutating = [
      '--add',
      '--replace-all',
      '--unset',
      '--unset-all',
      '--rename-section',
      '--remove-section',
      '--edit',
   ];
   if (hasOption(argv, ...mutating)) return false;
   if (
      hasOption(
         argv,
         '--list',
         '--get',
         '--get-all',
         '--get-regexp',
         '--get-urlmatch',
         '--get-color',
         '--get-colorbool'
      )
   ) {
      return true;
   }
   const positionals = argv.slice(1).filter((argument) => !argument.startsWith('-'));
   return positionals.length <= 1;
}

/**
 * Classifies one dispatch invocation and builds its capture plan without I/O.
 * @param argv - Command argv beginning with the routed command token.
 * @returns Redacted classification and, for reversible actions, capture requirements.
 */
export function classifyHistoryAction(argv: readonly string[]): HistoryActionClassification {
   const route = normalizeHistoryRoute(argv[0]);
   const originalArgv = redactHistoryArgv(argv);
   const normalizedArgv = originalArgv.slice();
   if (route) normalizedArgv[0] = route;
   const base = {
      route,
      normalizedArgv,
      originalArgv,
      originalCommand: formatCommand(originalArgv),
   };

   if (!route) return withoutCapture(base, 'unknown', null);
   if (ALWAYS_READ_ONLY.has(route)) return withoutCapture(base, 'no-history', route);

   if (route === 'commit') {
      if (hasOption(argv, '--dry-run')) return withoutCapture(base, 'no-history', 'commit:dry-run');
      const amend = hasOption(argv, '--amend');
      return reversible(
         base,
         amend ? 'commit:amend' : 'commit',
         ['refs', 'index'],
         extractPathspecs(argv, 1, true),
         { overwriteFlags: amend ? ['--amend'] : [], overwrites: amend, control: true }
      );
   }

   if (route === 'branch') {
      if (isReadOnlyBranch(argv)) return withoutCapture(base, 'no-history', 'branch:list');
      const overwriteFlags = getOverwriteFlags(route, argv);
      const changesConfig = hasOption(
         argv,
         '--set-upstream-to',
         '--unset-upstream',
         '--edit-description'
      );
      return reversible(base, 'branch', changesConfig ? ['refs', 'config'] : ['refs'], [], {
         overwriteFlags,
      });
   }

   if (route === 'tag') {
      const subcommand = normalizeSubcommand(argv[1], ['move', 'mv'], true);
      if (isReadOnlyTag(argv) && !subcommand) return withoutCapture(base, 'no-history', 'tag:list');
      const overwriteFlags = getOverwriteFlags(route, argv);
      return reversible(base, subcommand ? 'tag:move' : 'tag', ['refs'], [], {
         overwriteFlags,
         overwrites: overwriteFlags.length > 0 || subcommand != null || argv.includes('-d'),
      });
   }

   if (route === 'fetch') {
      if (hasOption(argv, '--dry-run')) return withoutCapture(base, 'no-history', 'fetch:dry-run');
      return reversible(base, 'fetch', ['refs'], [], {
         overwriteFlags: getOverwriteFlags(route, argv),
         control: true,
      });
   }

   if (route === 'reset') {
      const pathspecs = extractPathspecs(argv, 1, false);
      const mode =
         hasOption(argv, '--hard') || argv.includes('-h')
            ? 'hard'
            : hasOption(argv, '--soft') || argv.includes('-s')
              ? 'soft'
              : hasOption(argv, '--merge')
                ? 'merge'
                : hasOption(argv, '--keep')
                  ? 'keep'
                  : 'mixed';
      const domains: HistoryDomain[] = pathspecs.length
         ? ['index']
         : mode === 'soft'
           ? ['refs']
           : mode === 'hard' || mode === 'merge' || mode === 'keep'
             ? ['refs', 'index', 'worktree']
             : ['refs', 'index'];
      const overwriteFlags = getOverwriteFlags(route, argv);
      return reversible(
         base,
         pathspecs.length ? 'reset:paths' : `reset:${mode}`,
         domains,
         pathspecs,
         {
            overwriteFlags,
            overwrites: mode !== 'soft' || pathspecs.length > 0,
            control: !pathspecs.length,
         }
      );
   }

   if (route === 'add' || route === 'stage') {
      if (hasOption(argv, '--dry-run')) return withoutCapture(base, 'no-history', 'add:dry-run');
      return reversible(base, 'add', ['index'], extractPathspecs(argv, 1, true));
   }

   if (route === 'rm') {
      if (hasOption(argv, '--dry-run')) return withoutCapture(base, 'no-history', 'rm:dry-run');
      const cached = hasOption(argv, '--cached');
      return reversible(
         base,
         'rm',
         cached ? ['index'] : ['index', 'worktree'],
         extractPathspecs(argv, 1, true),
         {
            overwriteFlags: getOverwriteFlags(route, argv),
            overwrites: true,
         }
      );
   }

   if (route === 'restore') {
      const staged = hasOption(argv, '--staged', '-S');
      const worktree = hasOption(argv, '--worktree', '-W') || !staged;
      const domains: HistoryDomain[] = [];
      if (staged) domains.push('index');
      if (worktree) domains.push('worktree');
      return reversible(base, 'restore', domains, extractPathspecs(argv, 1, true), {
         overwrites: true,
      });
   }

   if (route === 'checkout' || route === 'switch') {
      const pathspecs = route === 'checkout' ? extractPathspecs(argv, 1, false) : [];
      const overwriteFlags = getOverwriteFlags(route, argv);
      return reversible(
         base,
         pathspecs.length ? 'checkout:paths' : route,
         pathspecs.length ? ['worktree'] : ['refs', 'index', 'worktree'],
         pathspecs,
         { overwriteFlags, control: !pathspecs.length }
      );
   }

   if (route === 'merge' || route === 'rebase' || route === 'cherry-pick' || route === 'revert') {
      if (hasOption(argv, '--quit')) {
         return reversible(base, `${route}:quit`, [], [], { control: true });
      }
      const mode = hasOption(argv, '--abort')
         ? 'abort'
         : hasOption(argv, '--continue')
           ? 'continue'
           : hasOption(argv, '--skip')
             ? 'skip'
             : null;
      return reversible(
         base,
         mode ? `${route}:${mode}` : route,
         ['refs', 'index', 'worktree'],
         [],
         {
            overwriteFlags: getOverwriteFlags(route, argv),
            overwrites: mode === 'abort' || mode === 'skip',
            control: true,
         }
      );
   }

   if (route === 'stash') {
      const subcommand =
         normalizeSubcommand(
            argv[1],
            ['apply', 'pop', 'list', 'drop', 'clear', 'show', 'push', 'save', 'create', 'store'],
            true
         ) || 'push';
      if (subcommand === 'drop' && argv[2] === 'pardon') {
         return withoutCapture(base, 'no-history', 'stash:drop:pardon');
      }
      if (subcommand === 'list' || subcommand === 'show' || subcommand === 'create') {
         return withoutCapture(base, 'no-history', `stash:${subcommand}`);
      }
      const pathStart = argv[1] && !argv[1].startsWith('-') ? 2 : 1;
      const pathspecs =
         subcommand === 'push' || subcommand === 'save'
            ? extractPathspecs(argv, pathStart, false)
            : [];
      const domains: HistoryDomain[] = ['stash'];
      if (
         subcommand === 'push' ||
         subcommand === 'save' ||
         subcommand === 'apply' ||
         subcommand === 'pop'
      ) {
         domains.push('index', 'worktree');
      }
      if (
         hasOption(argv, '--include-untracked', '--all') ||
         argv.includes('-u') ||
         argv.includes('-a')
      ) {
         domains.push('untracked');
      }
      return reversible(base, `stash:${subcommand}`, domains, pathspecs, {
         overwrites: subcommand === 'clear' || subcommand === 'drop' || subcommand === 'pop',
      });
   }

   if (route === 'clean') {
      if (hasOption(argv, '--dry-run') || argv.includes('-n')) {
         return withoutCapture(base, 'no-history', 'clean:dry-run');
      }
      return reversible(base, 'clean', ['worktree', 'untracked'], extractPathspecs(argv, 1, true), {
         overwriteFlags: getOverwriteFlags(route, argv),
         overwrites: true,
      });
   }

   if (route === 'clear') {
      const subcommand = normalizeSubcommand(argv[1], ['list', 'pardon']);
      if (subcommand === 'list') return withoutCapture(base, 'no-history', 'clear:list');
      return reversible(
         base,
         subcommand === 'pardon' ? 'clear:pardon' : 'clear',
         ['index', 'worktree', 'untracked'],
         [],
         {
            overwrites: true,
         }
      );
   }

   if (route === 'remote') {
      const subcommand = normalizeSubcommand(argv[1], [
         'add',
         'rename',
         'remove',
         'set-head',
         'set-branches',
         'get-url',
         'set-url',
         'show',
         'prune',
         'update',
      ]);
      if (!subcommand || subcommand === 'get-url' || subcommand === 'show') {
         return withoutCapture(
            base,
            'no-history',
            subcommand ? `remote:${subcommand}` : 'remote:list'
         );
      }
      return withoutCapture(base, 'audit-only', `remote:${subcommand}`);
   }

   if (route === 'config') {
      return withoutCapture(base, isReadOnlyConfig(argv) ? 'no-history' : 'audit-only', 'config');
   }

   if (route === 'gdx-config') {
      const subcommand = normalizeSubcommand(argv[1], ['list', 'path']);
      const positionals = argv.slice(1).filter((argument) => !argument.startsWith('-'));
      const readOnly =
         subcommand != null || (positionals.length <= 1 && !hasOption(argv, '--unset'));
      return withoutCapture(base, readOnly ? 'no-history' : 'audit-only', 'gdx-config');
   }

   if (route === 'reflog') {
      const subcommand = normalizeSubcommand(argv[1], [
         'show',
         'expire',
         'delete',
         'exists',
         'write',
      ]);
      const readOnly = !subcommand || subcommand === 'show' || subcommand === 'exists';
      return withoutCapture(
         base,
         readOnly ? 'no-history' : 'audit-only',
         subcommand ? `reflog:${subcommand}` : 'reflog:show'
      );
   }

   if (route === 'symbolic-ref') {
      const positionals = argv.slice(1).filter((argument) => !argument.startsWith('-'));
      return withoutCapture(
         base,
         positionals.length <= 1 ? 'no-history' : 'audit-only',
         'symbolic-ref'
      );
   }

   if (route === 'submodule') {
      const subcommand = normalizeSubcommand(argv[1], [
         'switch',
         'update',
         'status',
         'add',
         'sync',
         'summary',
         'deinit',
         'foreach',
      ]);
      const readOnly =
         !subcommand ||
         subcommand === 'switch' ||
         subcommand === 'status' ||
         subcommand === 'summary';
      return withoutCapture(
         base,
         readOnly ? 'no-history' : 'audit-only',
         subcommand ? `submodule:${subcommand}` : 'submodule'
      );
   }

   if (route === 'parallel') {
      const subcommand = normalizeSubcommand(argv[1], [
         'fork',
         'list',
         'open',
         'switch',
         'sync',
         'pick',
         'join',
         'remove',
         'help',
      ]);
      const readOnly =
         subcommand === 'list' ||
         subcommand === 'open' ||
         subcommand === 'switch' ||
         subcommand === 'help';
      return withoutCapture(
         base,
         readOnly ? 'no-history' : 'audit-only',
         subcommand ? `parallel:${subcommand}` : 'parallel'
      );
   }

   if (route === 'snap') {
      const subcommand = normalizeSubcommand(argv[1], [
         'worktree',
         'full',
         'list',
         'apply',
         'pop',
         'drop',
         'import',
         'export',
      ]);
      const mutatesRepo = subcommand === 'apply' || subcommand === 'pop';
      return withoutCapture(
         base,
         mutatesRepo ? 'audit-only' : 'no-history',
         subcommand ? `snap:${subcommand}` : 'snap:worktree'
      );
   }

   if (route === 'macro') {
      const subcommand = normalizeSubcommand(argv[1], ['set', 'list', 'drop', 'sync']);
      return withoutCapture(
         base,
         subcommand === 'list' ? 'no-history' : 'audit-only',
         subcommand ? `macro:${subcommand}` : 'macro'
      );
   }

   if (route === 'cache') return withoutCapture(base, 'no-history', 'cache');
   if (AUDIT_ONLY_ROUTES.has(route)) return withoutCapture(base, 'audit-only', route);

   // Every known but unsupported mutating route is retained as an audit event.
   return withoutCapture(base, 'audit-only', route);
}

/** Alias with a concise name for dispatch integration. */
export const classifyAction = classifyHistoryAction;
