import js from '@eslint/js';
import tseslint from 'typescript-eslint';

import preferLitedent from './scripts/eslint-rules/prefer-litedent';

export default [
   {
      ignores: ['test/dev/**', 'test/env/**', 'test/**/*.{js,cjs,mjs}'],
   },
   {
      ...js.configs.recommended,
      files: ['**/src/**/*.ts'],
   },
   ...tseslint.configs.recommended.map((config) => ({
      ...config,
      files: ['**/src/**/*.ts'],
   })),
   {
      files: ['**/{src,test}/**/*.ts'],
      languageOptions: {
         parser: tseslint.parser,
         parserOptions: {
            project: false,
            sourceType: 'module',
            ecmaVersion: 'latest',
            tsconfigRootDir: __dirname,
         },
      },
      plugins: {
         '@typescript-eslint': tseslint.plugin,
         gdx: {
            rules: {
               'prefer-litedent': preferLitedent,
            },
         },
      },
      rules: {
         'gdx/prefer-litedent': 'warn',
      },
   },
   {
      files: ['**/test/**/*.ts'],
      linterOptions: {
         reportUnusedDisableDirectives: false,
      },
   },
   {
      files: ['**/src/**/*.ts'],
      rules: {
         'no-console': 'warn',
         'no-fallthrough': 'off',
         'no-control-regex': 'off',
         '@typescript-eslint/no-explicit-any': 'warn',
      },
   },
];
