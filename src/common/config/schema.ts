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
   };
   cache?: {
      enabled?: boolean;
      maxAgeMinutes?: number;
   };
   parallel?: {
      init?: string;
   };
   defaultEditor: string;
}

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
   },
   cache: {
      enabled: true,
      maxAgeMinutes: DEFAULT_CACHE_MAX_AGE,
   },
   parallel: {
      init: 'submodule',
   },
   defaultEditor: 'code',
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
   'cache.enabled': 'GDX_CACHE_ENABLED',
   'cache.maxAgeMinutes': 'GDX_CACHE_MAX_AGE_MINUTES',
   'parallel.init': 'GDX_PARALLEL_INIT',
   defaultEditor: 'GDX_DEFAULT_EDITOR',
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
   cache: 'Configuration for caching mechanism.\nValues that are expensive to get are cached for faster subsequent access.',
   'cache.enabled': 'Whether caching is enabled',
   'cache.maxAgeMinutes':
      'Default maximum age of cache entries in minutes (some cache ignore this)',
   parallel: 'Configuration for parallel worktree automation',
   'parallel.init': 'Comma-separated list specifying what to init for new forks (submodule, pkg)',
   defaultEditor: 'Default code editor to open files with',
};
