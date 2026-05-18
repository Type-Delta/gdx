import { Type as t, type Static, type TSchema } from '@sinclair/typebox/type';
import { Value } from '@sinclair/typebox/value';

import { FORMATS } from '@/common/formats';
import { DEFAULT_CACHE_MAX_AGE } from '@/consts';

export const GdxConfigSchema = t.Object({
   llm: t.Optional(
      t.Object({
         provider: t.Optional(t.String()),
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
               useAdditionalContext: t.Optional(t.Boolean()),
               maxHunkSize: t.Optional(t.Integer({ minimum: 1 })),
            })
         ),
      })
   ),
   defaultEditor: t.String(),
   enhancedOutput: t.Optional(t.Boolean()),
   useInlineSubmodule: t.Optional(
      t.Union([t.Literal('off'), t.Literal('internal'), t.Literal('all')])
   ),
   useInlineGitConfig: t.Optional(t.Union([t.Literal('off'), t.Literal('internal')])),
});

export type GdxConfig = Static<typeof GdxConfigSchema>;

export interface ConfigValidationResult {
   valid: boolean;
   message?: string;
}

interface ObjectSchemaLike extends TSchema {
   properties?: Record<string, TSchema>;
}

/**
 * Gets the TypeBox schema for a dot-notation config key.
 * @param keyPath - Dot-notation config key.
 * @returns The TypeBox schema for that leaf key, or undefined for unknown keys.
 */
export function getConfigValueSchema(keyPath: string): TSchema | undefined {
   let schema: TSchema | undefined = GdxConfigSchema;

   for (const key of keyPath.split('.')) {
      const properties: Record<string, TSchema> | undefined = (schema as ObjectSchemaLike | undefined)
         ?.properties;
      schema = properties?.[key];
      if (!schema) return undefined;
   }

   return schema;
}

/**
 * Validates a config value against the schema for a dot-notation key.
 * @param keyPath - Dot-notation config key.
 * @param value - Value to validate.
 * @returns Validation result with a user-facing message when invalid.
 */
export function validateConfigValue(keyPath: string, value: unknown): ConfigValidationResult {
   const schema = getConfigValueSchema(keyPath);
   if (!schema) {
      return { valid: false, message: `Unknown configuration key '${keyPath}'.` };
   }

   if (Value.Check(schema, value)) {
      return { valid: true };
   }

   const allowed = getLiteralUnionValues(schema);
   if (allowed.length > 0) {
      return {
         valid: false,
         message: `Expected one of ${allowed.join(', ')} for '${keyPath}', got '${String(value)}'.`,
      };
   }

   const firstError = [...Value.Errors(schema, value)][0];
   return {
      valid: false,
      message: `Invalid value for '${keyPath}': ${firstError?.message ?? 'schema validation failed'}.`,
   };
}

/**
 * Coerces a string input from the CLI or environment into a typed config value.
 * @param keyPath - Dot-notation config key.
 * @param value - Raw string value.
 * @returns Coerced value, or an error message when coercion/validation fails.
 */
export function coerceConfigStringValue(
   keyPath: string,
   value: string
): { ok: true; value: unknown } | { ok: false; message: string } {
   const schema = getConfigValueSchema(keyPath);
   if (!schema) {
      return { ok: false, message: `Unknown configuration key '${keyPath}'.` };
   }

   let parsedValue: unknown = value;
   const schemaType = getSchemaType(schema);

   if (schemaType === 'number' || schemaType === 'integer') {
      const num = Number(value);
      if (Number.isNaN(num)) {
         return { ok: false, message: `Expected a number for '${keyPath}', got '${value}'` };
      }
      parsedValue = num;
   } else if (schemaType === 'boolean') {
      if (!['true', 'false', 'on', 'off'].includes(value.toLowerCase())) {
         return { ok: false, message: `Expected a boolean for '${keyPath}', got '${value}'` };
      }
      parsedValue = ['true', 'on'].includes(value.toLowerCase());
   } else if (schemaType === 'array') {
      try {
         parsedValue = JSON.parse(value);
      } catch {
         return {
            ok: false,
            message: `Expected a JSON array for '${keyPath}', got '${value}'. Example: ["**/*.foo"]`,
         };
      }
   } else if (acceptsNull(schema) && value.toLowerCase() === 'null') {
      parsedValue = null;
   }

   const validation = validateConfigValue(keyPath, parsedValue);
   if (!validation.valid) {
      return { ok: false, message: validation.message ?? `Invalid value for '${keyPath}'.` };
   }

   return { ok: true, value: parsedValue };
}

function getLiteralUnionValues(schema: TSchema): string[] {
   const variants = getSchemaVariants(schema);
   return variants
      .map((variant) => (variant as { const?: unknown }).const)
      .filter((value): value is string => typeof value === 'string');
}

function getSchemaType(schema: TSchema): string | undefined {
   const direct = (schema as { type?: string }).type;
   if (direct) return direct;

   for (const variant of getSchemaVariants(schema)) {
      const type = (variant as { type?: string }).type;
      if (type && type !== 'null') return type;
   }

   return undefined;
}

function getSchemaVariants(schema: TSchema): TSchema[] {
   return (
      (schema as { anyOf?: TSchema[] }).anyOf ??
      (schema as { oneOf?: TSchema[] }).oneOf ??
      (schema as { allOf?: TSchema[] }).allOf ??
      []
   );
}

function acceptsNull(schema: TSchema): boolean {
   if ((schema as { type?: string }).type === 'null') return true;
   return getSchemaVariants(schema).some((variant) => (variant as { type?: string }).type === 'null');
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
