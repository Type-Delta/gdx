import { describe, expect, it } from 'bun:test';

import {
   classifyHistoryAction,
   normalizeHistoryRoute,
   redactHistoryArgv,
} from '@/modules/history/classifier';

describe('history action classifier', () => {
   it('normalizes aliases and leaves read-only commands out of history', () => {
      expect(normalizeHistoryRoute('co')).toBe('checkout');
      expect(normalizeHistoryRoute('statu')).toBe('status');
      expect(normalizeHistoryRoute('c')).toBeNull();
      for (const argv of [['status'], ['diff'], ['branch', '--list'], ['tag', '-l'], ['stash', 'show']]) {
         expect(classifyHistoryAction(argv).disposition, argv.join(' ')).toBe('no-history');
      }
   });

   it('selects only minimal action-specific recipes', () => {
      const cases = [
         [['commit', '-m', 'x'], { kind: 'head-soft' }],
         [['commit', '--amend', '--no-edit'], { kind: 'head-soft' }],
         [['reset', '--soft', 'HEAD^'], { kind: 'head-soft' }],
         [['add', 'a.ts'], { kind: 'raw-index', redo: true }],
         [['switch', 'feature'], { kind: 'switch' }],
         [['branch', 'feature'], { kind: 'refs', refs: ['refs/heads/feature'] }],
         [['tag', 'v1', 'HEAD'], { kind: 'refs', refs: ['refs/tags/v1'] }],
         [['stash', 'drop', 'stash@{0}'], { kind: 'refs', refs: ['refs/stash'] }],
      ] as const;
      for (const [argv, recipe] of cases) {
         const result = classifyHistoryAction(argv);
         expect(result.disposition, argv.join(' ')).toBe('reversible');
         expect(result.capture).toEqual(recipe);
      }
   });

   it('audits destructive or ambiguous local mutations', () => {
      for (const argv of [
         ['reset', '--hard', 'HEAD^'],
         ['checkout', '-f', 'feature'],
         ['checkout', 'feature'],
         ['checkout', 'a.ts'],
         ['checkout', 'HEAD', '--', 'a.ts'],
         ['switch', '--orphan', 'new-root'],
         ['branch', '-m', 'renamed'],
         ['branch', '-m', 'old', 'renamed'],
         ['branch', '-c', 'copied'],
         ['merge', 'feature'],
         ['rebase', 'main'],
         ['restore', 'a.ts'],
         ['clean', '-fd'],
         ['stash', 'pop'],
      ]) {
         const result = classifyHistoryAction(argv);
         expect(result.disposition, argv.join(' ')).toBe('audit-only');
         expect(result.capture).toBeNull();
      }
      expect(classifyHistoryAction(['tag', '-d', 'one', 'two']).capture).toEqual({
         kind: 'refs',
         refs: ['refs/tags/one', 'refs/tags/two'],
      });
   });

   it('never records history commands and skips dry runs', () => {
      expect(classifyHistoryAction(['history', 'undo']).disposition).toBe('no-history');
      expect(classifyHistoryAction(['add', '--dry-run', '.']).disposition).toBe('no-history');
      expect(classifyHistoryAction(['clean', '-n']).disposition).toBe('no-history');
   });

   it('redacts secrets without mutating argv', () => {
      const argv = ['push', '--token=secret', 'https://alice:secret@example.com/repo.git'];
      expect(redactHistoryArgv(argv)).toEqual([
         'push',
         '--token=[REDACTED]',
         'https://[REDACTED]@example.com/repo.git',
      ]);
      expect(argv[1]).toBe('--token=secret');
   });
});
