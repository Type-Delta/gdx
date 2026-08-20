/**
 * How the history dispatcher should treat an invocation.
 */
export type HistoryDisposition = 'no-history' | 'reversible' | 'audit-only' | 'unknown';

/**
 * State capture requested for a reversible action.
 */
export type ReversibleCapturePlan =
   | { kind: 'head-soft' }
   | { kind: 'switch' }
   | { kind: 'refs'; refs: readonly string[] }
   | { kind: 'raw-index'; redo: boolean }
   | { kind: 'snapshot' }
   | { kind: 'audit' };

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
   'sync',
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
   'sync',
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

/** Detects reword preview modes without treating message values as options. */
function hasRewordPreviewOption(argv: readonly string[]): boolean {
   for (let index = 1; index < argv.length; index++) {
      const argument = argv[index];
      if (argument === '-m' || argument === '--message') {
         index++;
         continue;
      }
      if (argument === '--preview' || argument === '--no-commit' || argument === '-nc') return true;
   }
   return false;
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
 * Creates the common reversible result payload.
 * @param base - Result fields shared by every disposition.
 * @param action - Stable action identifier.
 * @param capture - Minimal action-specific inverse inputs.
 * @returns Reversible classification.
 */
function reversible(
   base: Omit<HistoryActionClassification, 'disposition' | 'action' | 'capture'>,
   action: string,
   capture: ReversibleCapturePlan
): HistoryActionClassification {
   return {
      ...base,
      disposition: 'reversible',
      action,
      capture,
   };
}

/** Resolves direct branch refs for simple create/delete/move forms. */
function branchRefs(argv: readonly string[]): string[] {
   const names = argv.slice(1).filter((value) => !value.startsWith('-'));
   if (!names.length) return [];
   const selected = hasOption(argv, '--delete', '-d', '-D') ? names : names.slice(0, 1);
   return [...new Set(selected.map((name) => `refs/heads/${name}`))];
}

/** Resolves the tag directly named by create/delete/force forms. */
function tagRefs(argv: readonly string[]): string[] {
   const names = argv.slice(1).filter((value) => !value.startsWith('-'));
   if (hasOption(argv, '--delete', '-d')) {
      return [...new Set(names.map((name) => `refs/tags/${name}`))];
   }
   if (names[0] === 'move' || names[0] === 'mv') return [];
   return names[0] ? [`refs/tags/${names[0]}`] : [];
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

   // ponytail: only cheap, identifiable inverses are reversible; the journal audits the rest.
   if (route === 'commit') {
      if (hasOption(argv, '--dry-run')) return withoutCapture(base, 'no-history', 'commit:dry-run');
      return reversible(base, hasOption(argv, '--amend') ? 'commit:amend' : 'commit', {
         kind: 'head-soft',
      });
   }
   if (route === 'reword') {
      if (hasRewordPreviewOption(argv)) {
         return withoutCapture(base, 'no-history', 'reword:preview');
      }
      return reversible(base, 'reword', { kind: 'head-soft' });
   }
   if (route === 'branch') {
      if (isReadOnlyBranch(argv)) return withoutCapture(base, 'no-history', 'branch:list');
      if (
         hasOption(
            argv,
            '--set-upstream-to',
            '--unset-upstream',
            '--edit-description',
            '--move',
            '-m',
            '-M',
            '--copy',
            '-c',
            '-C'
         )
      ) {
         return withoutCapture(base, 'audit-only', 'branch');
      }
      const refs = branchRefs(argv);
      return refs.length
         ? reversible(base, 'branch', { kind: 'refs', refs })
         : withoutCapture(base, 'audit-only', 'branch');
   }
   if (route === 'tag') {
      if (isReadOnlyTag(argv)) return withoutCapture(base, 'no-history', 'tag:list');
      const refs = tagRefs(argv);
      return refs.length
         ? reversible(base, 'tag', { kind: 'refs', refs })
         : withoutCapture(base, 'audit-only', 'tag');
   }
   if (route === 'reset') {
      const isSoft = hasOption(argv, '--soft') || argv.includes('-s');
      const hasPaths = argv.includes('--');
      return isSoft && !hasPaths
         ? reversible(base, 'reset:soft', { kind: 'head-soft' })
         : withoutCapture(base, 'audit-only', 'reset');
   }
   if (route === 'add' || route === 'stage') {
      if (hasOption(argv, '--dry-run')) return withoutCapture(base, 'no-history', 'add:dry-run');
      return reversible(base, 'add', { kind: 'raw-index', redo: true });
   }
   if (route === 'checkout') return withoutCapture(base, 'audit-only', 'checkout');
   if (route === 'switch') {
      const destructive = hasOption(
          argv,
          '--force',
          '-f',
         '--discard-changes',
         '--orphan',
         '--create',
         '--force-create',
          '-b',
          '-B',
          '-c',
          '-C'
      );
      return destructive
         ? withoutCapture(base, 'audit-only', 'switch')
         : reversible(base, 'switch', { kind: 'switch' });
   }
   if (route === 'stash') {
      if (argv[1] === 'drop' && argv[2] === 'pardon') {
         return withoutCapture(base, 'no-history', 'stash:drop:pardon');
      }
      if (normalizeSubcommand(argv[1], ['drop']) === 'drop') {
         return reversible(base, 'stash:drop', { kind: 'refs', refs: ['refs/stash'] });
      }
      const subcommand = normalizeSubcommand(argv[1], ['list', 'show', 'create']) ?? 'push';
      if (['list', 'show', 'create'].includes(subcommand)) {
         return withoutCapture(base, 'no-history', `stash:${subcommand}`);
      }
   }
   if (route === 'clear' && normalizeSubcommand(argv[1], ['list']) === 'list') {
      return withoutCapture(base, 'no-history', 'clear:list');
   }
   if (
      ['fetch', 'rm', 'restore', 'merge', 'revert', 'stash', 'clean', 'clear'].includes(route)
   ) {
      const dryRun = hasOption(argv, '--dry-run') || (route === 'clean' && argv.includes('-n'));
      return withoutCapture(base, dryRun ? 'no-history' : 'audit-only', route);
   }

   if (route === 'rebase' || route === 'cherry-pick') {
      const dryRun = hasOption(argv, '--dry-run');
      const control = hasOption(argv, '--abort', '--continue', '--skip', '--quit') ||
         argv.some((argument) => argument === 'abort' || argument === 'continue' || argument === 'skip' || argument === 'quit');
      return dryRun
         ? withoutCapture(base, 'no-history', route)
         : control
            ? withoutCapture(base, 'audit-only', route)
            : reversible(base, route, { kind: 'snapshot' });
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
