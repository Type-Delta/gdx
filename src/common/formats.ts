import { FormatRegistry } from '@/modules/typebox';

const PARALLEL_INIT_VALUES = ['submodule', 'env', 'pkg'] as const;

/**
 * Shared TypeBox custom format names.
 */
export const FORMATS = {
   /**
    * Validates a comma-separated list of parallel worktree init behaviors.
    * Accepted values are: submodule, env, and pkg.
    */
   parallelInit: 'parallel-init',

   /**
    * Validates a colon-separated list where each entry must contain non-whitespace text.
    * Empty strings are allowed to represent no configured patterns.
    */
   colonSeparatedPatterns: 'colon-separated-patterns',
} as const;

FormatRegistry.Set(FORMATS.parallelInit, (value) => {
   if (value.trim() === '') return true;
   return value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
      .every((entry) => PARALLEL_INIT_VALUES.includes(entry as (typeof PARALLEL_INIT_VALUES)[number]));
});

FormatRegistry.Set(FORMATS.colonSeparatedPatterns, (value) => {
   if (value === '') return true;
   return value.split(':').every((entry) => entry.trim().length > 0);
});
