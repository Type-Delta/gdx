import { describe, expect, it } from 'bun:test';
import { Linter } from 'eslint';

import preferLitedent from '../../scripts/eslint-rules/prefer-litedent';

const linter = new Linter();
const config = {
   plugins: {
      gdx: {
         rules: {
            'prefer-litedent': preferLitedent,
         },
      },
   },
   rules: {
      'gdx/prefer-litedent': 'warn',
   },
} as const;

describe('prefer-litedent', () => {
   it('reports multiline string array literals joined with a newline', () => {
      const messages = linter.verify(
         `const text = [
            'commit abc123456789',
            'Author: Test User <test@example.com>',
            'Date: Sat May 16 12:00:00 2026 +0700',
            '',
            'empty commit',
         ].join('\\n');`,
         config
      );

      expect(messages.map(({ ruleId }) => ruleId)).toEqual(['gdx/prefer-litedent']);
   });

   it('reports multiline interpolated text', () => {
      const messages = linter.verify(
         "const usage = [\n`${name} merge <args>`,\n`${name} merge --continue`,\n].join('\\n');",
         config
      );

      expect(messages.map(({ ruleId }) => ruleId)).toEqual(['gdx/prefer-litedent']);
   });

   it('allows short fixture arrays kept on one line', () => {
      const messages = linter.verify(
         "const text = ['one', 'two', 'three', 'four'].join('\\n');",
         config
      );

      expect(messages).toEqual([]);
   });

   it('allows computed arrays', () => {
      const messages = linter.verify("process.stdout.write(rows.map(render).join('\\n'));", config);

      expect(messages).toEqual([]);
   });
});
