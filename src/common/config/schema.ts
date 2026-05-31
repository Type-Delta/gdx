import { FORMATS } from '@/common/formats';
import { Type as t, type Static } from '@/modules/typebox';
import { DEFAULT_CACHE_MAX_AGE } from '@/consts';

export const GdxConfigSchema = t.Object({
   llm: t.Optional(
      t.Object({
         provider: t.Optional(t.Union([t.Literal('openai'), t.Literal('openrouter')])),
         apiKey: t.Optional(t.String()),
         baseUrl: t.Optional(t.String()),
         model: t.Optional(t.String()),
         temperature: t.Optional(t.Number({ minimum: 0, maximum: 2 })),
         maxTokens: t.Optional(t.Integer({ minimum: 1 })),
         showThinking: t.Optional(t.Boolean()),
      })
   ),
   lint: t.Optional(
      t.Object({
         onPushBehavior: t.Optional(
            t.Union([t.Literal('off'), t.Literal('error'), t.Literal('warning')])
         ),
         maxFileSizeKb: t.Optional(t.Integer({ minimum: 1 })),
      })
   ),
   stash: t.Optional(
      t.Object({
         undoLimit: t.Optional(t.Integer({ minimum: 0 })),
      })
   ),
   commit: t.Optional(
      t.Object({
         commitPattern: t.Optional(t.Union([t.Literal('inherit'), t.Literal('comprehensive')])),
         guidelineCacheDays: t.Optional(t.Integer({ minimum: 0 })),
         noisyFiles: t.Optional(t.Array(t.String())),
      })
   ),
   reword: t.Optional(
      t.Object({
         editor: t.Optional(t.Union([t.String(), t.Null()])),
      })
   ),
   cache: t.Optional(
      t.Object({
         enabled: t.Optional(t.Boolean()),
         maxAgeMinutes: t.Optional(t.Number({ minimum: 0 })),
      })
   ),
   parallel: t.Optional(
      t.Object({
         init: t.Optional(t.String({ format: FORMATS.parallelInit })),
         envPaths: t.Optional(t.String({ format: FORMATS.colonSeparatedPatterns })),
      })
   ),
   viewer: t.Optional(
      t.Object({
         highlighting: t.Optional(
            t.Object({
               fullfileHighlight: t.Optional(t.Boolean()),
               maxHunkSize: t.Optional(t.Integer({ minimum: 1 })),
            })
         ),
         exitBehavior: t.Optional(
            t.Union([t.Literal('clearScreen'), t.Literal('nextLine')])
         ),
      })
   ),
   defaultEditor: t.String(),
   enhancedOutput: t.Optional(t.Boolean()),
   useInlineSubmodule: t.Optional(
      t.Union([t.Literal('off'), t.Literal('internal'), t.Literal('all')])
   ),
   useInlineGitConfig: t.Optional(t.Union([t.Literal('off'), t.Literal('internal')])),
   maxThreadWorkers: t.Optional(t.Integer({ minimum: 1 })),
});

export type GdxConfig = Static<typeof GdxConfigSchema>;

export const COMMIT_DEFAULT_NOISY_FILES = [
   '**/package-lock.json',
   '**/bun.lock',
   '**/yarn.lock',
   '**/pnpm-lock.yaml',
   '**/npm-shrinkwrap.json',
   '**/__snapshots__/*.snap',
   '**/*.snap',
   '**/dist/**',
   '**/build/**',
   '**/coverage/**',
   '**/out/**',
   '**/*.min.js',
   '**/*.min.css',
] as const;

export const DEFAULT_CONFIG: GdxConfig = {
   llm: {
      provider: 'openai',
      model: 'gpt-5-nano',
      temperature: 0.14,
      maxTokens: undefined,
      apiKey: undefined,
      baseUrl: undefined,
      showThinking: false,
   },
   lint: {
      onPushBehavior: 'off',
      maxFileSizeKb: 1024, // 1MB
   },
   stash: {
      undoLimit: 10,
   },
   commit: {
      commitPattern: 'inherit',
      guidelineCacheDays: 30,
      noisyFiles: [...COMMIT_DEFAULT_NOISY_FILES],
   },
   reword: {
      editor: null,
   },
   cache: {
      enabled: true,
      maxAgeMinutes: DEFAULT_CACHE_MAX_AGE,
   },
   parallel: {
      init: 'submodule,env',
      envPaths: '',
   },
   viewer: {
      highlighting: {
         fullfileHighlight: true,
         maxHunkSize: 200000,
      },
      exitBehavior: 'nextLine',
   },
   defaultEditor: 'code',
   enhancedOutput: true,
   useInlineSubmodule: 'internal',
   useInlineGitConfig: 'internal',
   maxThreadWorkers: 8,
};

export const ENV_PREFIX = 'GDX_';

// Mapping of config keys to environment variable names
export const ENV_MAPPINGS: Record<string, string> = {
   'llm.provider': 'GDX_LLM_PROVIDER',
   'llm.apiKey': 'GDX_LLM_API_KEY',
   'llm.baseUrl': 'GDX_LLM_BASE_URL',
   'llm.model': 'GDX_LLM_MODEL',
   'llm.temperature': 'GDX_LLM_TEMPERATURE',
   'llm.maxTokens': 'GDX_LLM_MAX_TOKENS',
   'llm.showThinking': 'GDX_LLM_SHOW_THINKING',
   'lint.onPushBehavior': 'GDX_LINT_ON_PUSH_BEHAVIOR',
   'lint.maxFileSizeKb': 'GDX_LINT_MAX_FILE_SIZE_KB',
   'stash.undoLimit': 'GDX_STASH_UNDO_LIMIT',
   'commit.commitPattern': 'GDX_COMMIT_PATTERN',
   'commit.guidelineCacheDays': 'GDX_COMMIT_GUIDELINE_CACHE_DAYS',
   'reword.editor': 'GDX_REWORD_EDITOR',
   'cache.enabled': 'GDX_CACHE_ENABLED',
   'cache.maxAgeMinutes': 'GDX_CACHE_MAX_AGE_MINUTES',
   'parallel.init': 'GDX_PARALLEL_INIT',
   'parallel.envPaths': 'GDX_PARALLEL_ENV_PATHS',
   'viewer.highlighting.fullfileHighlight': 'GDX_VIEWER_HIGHLIGHTING_FULLFILE_HIGHLIGHT',
   'viewer.highlighting.maxHunkSize': 'GDX_VIEWER_HIGHLIGHTING_MAX_HUNK_SIZE',
   'viewer.exitBehavior': 'GDX_VIEWER_EXIT_BEHAVIOR',
   defaultEditor: 'GDX_DEFAULT_EDITOR',
   enhancedOutput: 'GDX_ENHANCED_OUTPUT',
   useInlineSubmodule: 'GDX_USE_INLINE_SUBMODULE',
   useInlineGitConfig: 'GDX_USE_INLINE_GIT_CONFIG',
   maxThreadWorkers: 'GDX_MAX_THREAD_WORKERS',
};

// Configuration field descriptions
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
   llm: 'Configuration for the Language Model (LLM) integration',
   'llm.provider': 'LLM provider to use (openai, openrouter)',
   'llm.apiKey': 'API key for the LLM provider',
   'llm.baseUrl': 'Base URL for the LLM API (optional)',
   'llm.model': 'Model to use for LLM requests',
   'llm.temperature': 'Temperature for LLM generation (0-2)',
   'llm.maxTokens': 'Maximum tokens for LLM responses',
   'llm.showThinking': 'Whether to show part of LLM reasoning messages',
   lint: 'Configuration for post-commit linting',
   'lint.onPushBehavior': 'Lint behavior before push (off, error, warning)',
   'lint.maxFileSizeKb': 'Maximum allowed file size in KiB',
   'stash.undoLimit': 'Max number of stash drops to keep in history',
   commit: 'Configuration for commit message generation',
   'commit.commitPattern':
      'Commit message pattern (inherit: learn from repo, comprehensive: fixed format)',
   'commit.guidelineCacheDays': 'Days to cache learned commit guidelines per repository',
   'commit.noisyFiles':
      'Files treated as noisy in commit auto diff summary (array of glob patterns matching relative paths)',
   reword: 'Configuration for rewording commit messages',
   'reword.editor': 'Editor command used by gdx reword (overrides global editor when set)',
   cache: 'Configuration for caching mechanism.\nValues that are expensive to get are cached for faster subsequent access.',
   'cache.enabled': 'Whether caching is enabled',
   'cache.maxAgeMinutes':
      'Default maximum age of cache entries in minutes (some cache ignore this)',
   parallel: 'Configuration for parallel worktree automation',
   'parallel.init':
      'Comma-separated list specifying what to init for new forks (submodule, env, pkg)',
   'parallel.envPaths':
      'Colon-separated list of .gitignore patterns for env files to copy into new forks',
   viewer: 'Configuration for enhanced terminal viewers',
   'viewer.highlighting': 'Configuration for syntax highlighting in enhanced viewers',
   'viewer.highlighting.fullfileHighlight':
      'Highlight diffs by loading full old/new file contents from git or FS when possible (disable for files exceeding viewer.highlighting.maxHunkSize)',
   'viewer.highlighting.maxHunkSize':
      'Maximum full file size in characters that are allowed for fullfileHighlight to be applied',
   'viewer.exitBehavior':
      "Behavior when exiting the pager ('nextLine' keeps content in scroll buffer, 'clearScreen' removes pager content from scroll buffer, and 'none' leaves the content and cursor position unchanged)",
   defaultEditor: 'Default code editor to open files with',
   enhancedOutput:
      "Whether to enhanced Git's output (modify the output of some git commands when conditions are met)",
   useInlineSubmodule:
      '[Experimental] Select submodule implementation mode (off: git-only, internal: gdx internal flow, all: reserved for broader internal usage)',
   useInlineGitConfig:
      '[Experimental] Select git config implementation mode (off: use git executable, internal: read/write git config files directly)',
   maxThreadWorkers: 'Maximum number of worker threads for process spawning and high resource intensive tasks (default: 8)',
};
