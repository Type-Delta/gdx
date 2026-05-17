import { DEFAULT_CACHE_MAX_AGE } from '@/consts';

export interface GdxConfig {
   llm?: {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      showThinking?: boolean;
   };
   lint?: {
      onPushBehavior?: 'off' | 'error' | 'warning';
      maxFileSizeKb?: number;
   };
   stash?: {
      undoLimit?: number;
   };
   commit?: {
      commitPattern?: 'inherit' | 'comprehensive';
      guidelineCacheDays?: number;
      noisyFiles?: string[];
   };
   reword?: {
      editor?: string | null;
   };
   cache?: {
      enabled?: boolean;
      maxAgeMinutes?: number;
   };
   parallel?: {
      init?: string;
      envPaths?: string;
   };
   viewer?: {
      highlighting?: {
         useAdditionalContext?: boolean;
         maxHunkSize?: number;
      };
   };
   defaultEditor: string;
   enhancedOutput?: boolean;
   useInlineSubmodule?: 'off' | 'internal' | 'all';
   useInlineGitConfig?: 'off' | 'internal';
}

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
         useAdditionalContext: true,
         maxHunkSize: 200000,
      },
   },
   defaultEditor: 'code',
   enhancedOutput: true,
   useInlineSubmodule: 'internal',
   useInlineGitConfig: 'internal',
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
   'viewer.highlighting.useAdditionalContext': 'GDX_VIEWER_HIGHLIGHTING_USE_ADDITIONAL_CONTEXT',
   'viewer.highlighting.maxHunkSize': 'GDX_VIEWER_HIGHLIGHTING_MAX_HUNK_SIZE',
   defaultEditor: 'GDX_DEFAULT_EDITOR',
   enhancedOutput: 'GDX_ENHANCED_OUTPUT',
   useInlineSubmodule: 'GDX_USE_INLINE_SUBMODULE',
   useInlineGitConfig: 'GDX_USE_INLINE_GIT_CONFIG',
};

// Configuration field descriptions
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
   llm: 'Configuration for the Language Model (LLM) integration',
   'llm.provider': 'LLM provider to use (e.g., openai)',
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
   'viewer.highlighting.useAdditionalContext':
      'Highlight diffs by loading full old/new file contents from git object history when commit refs are available',
   'viewer.highlighting.maxHunkSize':
      'Maximum full file size in characters to syntax-highlight when additional context is enabled',
   defaultEditor: 'Default code editor to open files with',
   enhancedOutput:
      "Whether to enhanced Git's output (modify the output of some git commands when conditions are met)",
   useInlineSubmodule:
      '[Experimental] Select submodule implementation mode (off: git-only, internal: gdx internal flow, all: reserved for broader internal usage)',
   useInlineGitConfig:
      '[Experimental] Select git config implementation mode (off: use git executable, internal: read/write git config files directly)',
};
