export interface GdxConfig {
   llm?: {
      provider?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
   };
   lint?: {
      onPushBehavior?: 'off' | 'error' | 'warning';
      maxFileSizeKb?: number;
   };
   stash?: {
      undoLimit?: number;
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
   },
   lint: {
      onPushBehavior: 'off',
      maxFileSizeKb: 1024, // 1MB
   },
   stash: {
      undoLimit: 10,
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
   'lint.onPushBehavior': 'GDX_LINT_ON_PUSH_BEHAVIOR',
   'lint.maxFileSizeKb': 'GDX_LINT_MAX_FILE_SIZE_KB',
   'stash.undoLimit': 'GDX_STASH_UNDO_LIMIT',
   defaultEditor: 'GDX_DEFAULT_EDITOR',
};

// Configuration field descriptions
export const CONFIG_DESCRIPTIONS: Record<string, string> = {
   'llm.provider': 'LLM provider to use (e.g., openai)',
   'llm.apiKey': 'API key for the LLM provider',
   'llm.baseUrl': 'Base URL for the LLM API (optional)',
   'llm.model': 'Model to use for LLM requests',
   'llm.temperature': 'Temperature for LLM generation (0-2)',
   'llm.maxTokens': 'Maximum tokens for LLM responses',
   'lint.onPushBehavior': 'Lint behavior before push (off, error, warning)',
   'lint.maxFileSizeKb': 'Maximum allowed file size in KB',
   'stash.undoLimit': 'Max number of stash drops to keep in history',
   defaultEditor: 'Default code editor to open files with',
};
