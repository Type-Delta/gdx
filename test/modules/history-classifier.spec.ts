import { describe, expect, it } from 'bun:test';

import {
   classifyHistoryAction,
   normalizeHistoryRoute,
   redactHistoryArgv,
   type HistoryDisposition,
   type HistoryDomain,
} from '@/modules/history/classifier';

describe('history action classifier', () => {
   it('normalizes dispatch aliases and unique route abbreviations', () => {
      const aliases: Record<string, string> = {
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
         statu: 'status',
         history: 'history',
      };

      for (const [input, expected] of Object.entries(aliases)) {
         expect(normalizeHistoryRoute(input)).toBe(expected);
      }
      expect(normalizeHistoryRoute('c')).toBeNull();
      expect(normalizeHistoryRoute('definitely-not-git')).toBeNull();
   });

   it('classifies known read-only routes without capture', () => {
      const commands = [
         ['status'],
         ['diff', '--stat'],
         ['log', '--oneline'],
         ['show', 'HEAD'],
         ['blame', 'file.ts'],
         ['grep', 'needle'],
         ['ls-files'],
         ['graph'],
         ['stats'],
         ['doctor'],
         ['nocap'],
         ['branch', '--list', 'feature/*'],
         ['tag', '-l'],
         ['stash', 'show'],
         ['remote', 'get-url', 'origin'],
         ['config', '--get', 'user.name'],
         ['clear', 'list'],
      ];

      for (const command of commands) {
         const result = classifyHistoryAction(command);
         expect(result.disposition, command.join(' ')).toBe('no-history');
         expect(result.capture).toBeNull();
      }
   });

   it('never turns history operations into history transactions', () => {
      for (const command of [
         ['history'],
         ['history', 'list'],
         ['history', 'undo', '~2'],
         ['history', 'redo'],
         ['history', 'snapshot', 'create'],
         ['history', 'restore', 'transaction-id', '--force'],
         ['history', 'prune', '--all'],
         ['history', 'unknown-future-operation'],
      ]) {
         const result = classifyHistoryAction(command);
         expect(result.route, command.join(' ')).toBe('history');
         expect(result.disposition, command.join(' ')).toBe('no-history');
         expect(result.capture).toBeNull();
      }
   });

   it('classifies reversible routed actions with affected domains', () => {
      const cases: Array<[string[], string, HistoryDomain[]]> = [
         [['commit', '-m', 'subject'], 'commit', ['refs', 'index']],
         [['commit', '--amend', '--no-edit'], 'commit:amend', ['refs', 'index']],
         [['branch', 'feature'], 'branch', ['refs']],
         [['tag', 'v1.0.0'], 'tag', ['refs']],
         [['tag', 'mv', 'v1', 'HEAD~1'], 'tag:move', ['refs']],
         [['fetch', 'origin'], 'fetch', ['refs']],
         [['reset', '--soft', 'HEAD~1'], 'reset:soft', ['refs']],
         [['reset', '--mixed', 'HEAD~1'], 'reset:mixed', ['refs', 'index']],
         [['reset', '--hard', 'HEAD~1'], 'reset:hard', ['refs', 'index', 'worktree']],
         [['add', 'src/a.ts'], 'add', ['index']],
         [['rm', 'src/a.ts'], 'rm', ['index', 'worktree']],
         [['rm', '--cached', 'src/a.ts'], 'rm', ['index']],
         [['restore', 'src/a.ts'], 'restore', ['worktree']],
         [['restore', '--staged', 'src/a.ts'], 'restore', ['index']],
         [['restore', '--staged', '--worktree', 'src/a.ts'], 'restore', ['index', 'worktree']],
         [['checkout', 'feature'], 'checkout', ['refs', 'index', 'worktree']],
         [['switch', 'feature'], 'switch', ['refs', 'index', 'worktree']],
         [['merge', 'feature'], 'merge', ['refs', 'index', 'worktree']],
         [['rebase', 'main'], 'rebase', ['refs', 'index', 'worktree']],
         [['cherry-pick', 'abc123'], 'cherry-pick', ['refs', 'index', 'worktree']],
         [['revert', 'abc123'], 'revert', ['refs', 'index', 'worktree']],
         [['stash', 'push'], 'stash:push', ['stash', 'index', 'worktree']],
         [['stash', 'drop', 'stash@{0}'], 'stash:drop', ['stash']],
         [['clean', '-fd'], 'clean', ['worktree', 'untracked']],
         [['clear'], 'clear', ['index', 'worktree', 'untracked']],
      ];

      for (const [command, action, domains] of cases) {
         const result = classifyHistoryAction(command);
         expect(result.disposition, command.join(' ')).toBe('reversible');
         expect(result.action).toBe(action);
         expect(result.capture?.domains).toEqual(domains);
      }
   });

   it('extracts only targeted pathspecs', () => {
      const cases: Array<[string[], string[]]> = [
         [
            ['add', '-A', '--', 'src/a.ts', 'space name.ts'],
            ['src/a.ts', 'space name.ts'],
         ],
         [['commit', '-m', 'subject', '--', 'src/a.ts'], ['src/a.ts']],
         [
            ['rm', '--cached', 'src/a.ts', 'src/b.ts'],
            ['src/a.ts', 'src/b.ts'],
         ],
         [['restore', '--source', 'HEAD~1', '--', 'src/a.ts'], ['src/a.ts']],
         [['reset', 'HEAD', '--', 'src/a.ts'], ['src/a.ts']],
         [['checkout', 'HEAD', '--', 'src/a.ts'], ['src/a.ts']],
         [['stash', 'push', '-m', 'save work', '--', 'src/a.ts'], ['src/a.ts']],
         [['clean', '-fd', '--', 'generated/a.js'], ['generated/a.js']],
         [['switch', 'feature'], []],
      ];

      for (const [command, pathspecs] of cases) {
         expect(classifyHistoryAction(command).capture?.pathspecs, command.join(' ')).toEqual(
            pathspecs
         );
      }
   });

   it('captures overwrite flags and control-state requirements', () => {
      const hardReset = classifyHistoryAction(['reset', '-h', 'HEAD~1']);
      expect(hardReset.capture?.overwriteFlags).toEqual(['--hard']);
      expect(hardReset.capture?.overwrites).toBeTrue();
      expect(hardReset.capture?.needsControlState).toBeTrue();

      const checkout = classifyHistoryAction(['checkout', '-f', 'feature']);
      expect(checkout.capture?.overwriteFlags).toEqual(['--force']);
      expect(checkout.capture?.needsControlState).toBeTrue();

      const clean = classifyHistoryAction(['clean', '-fdx']);
      expect(clean.capture?.overwriteFlags).toEqual(['--force', '-x']);
      expect(clean.capture?.overwrites).toBeTrue();

      for (const command of [['merge'], ['rebase'], ['cherry-pick'], ['revert']]) {
         expect(classifyHistoryAction(command).capture?.needsControlState).toBeTrue();
      }
   });

   it('uses explicit sequencer actions', () => {
      expect(classifyHistoryAction(['merge', '--abort']).action).toBe('merge:abort');
      expect(classifyHistoryAction(['rebase', '--continue']).action).toBe('rebase:continue');
      expect(classifyHistoryAction(['cherry-pick', '--skip']).action).toBe('cherry-pick:skip');
      expect(classifyHistoryAction(['revert', '--quit']).action).toBe('revert:quit');
   });

   it('does not record dry runs', () => {
      for (const command of [
         ['commit', '--dry-run'],
         ['fetch', '--dry-run'],
         ['add', '--dry-run', '.'],
         ['rm', '--dry-run', 'a'],
         ['clean', '-n'],
      ]) {
         expect(classifyHistoryAction(command).disposition, command.join(' ')).toBe('no-history');
      }
   });

   it('classifies risky and unsupported mutations as strict audit-only', () => {
      const commands = [
         ['push', '--force'],
         ['remote', 'set-url', 'origin', 'https://example.com/repo.git'],
         ['gc', '--prune=now'],
         ['prune'],
         ['config', '--global', 'credential.helper', 'store'],
         ['config', '--system', '--unset', 'http.proxy'],
         ['pull', '--rebase'],
         ['worktree', 'remove', '--force', '../other'],
         ['submodule', 'deinit', '--all'],
         ['reword', 'HEAD~2'],
         ['snap', 'apply', 'abc123'],
      ];

      for (const command of commands) {
         const result = classifyHistoryAction(command);
         expect(result.disposition, command.join(' ')).toBe('audit-only');
         expect(result.capture).toBeNull();
      }
   });

   it('reserves unknown for invocations with no existing route match', () => {
      const known = ['push', 'gc', 'worktree', 'apply', 'update-ref', 'gh'];
      for (const command of known) {
         expect(classifyHistoryAction([command]).disposition).not.toBe('unknown');
      }

      const result = classifyHistoryAction(['mystery-destroy', '--force']);
      expect(result.disposition).toBe('unknown');
      expect(result.route).toBeNull();
      expect(result.capture).toBeNull();
   });

   it('redacts sensitive original option, config, and URL values without mutating input', () => {
      const input = [
         'push',
         '--token=top-secret',
         '--password',
         'hunter2',
         '-c',
         'http.extraHeader=Authorization: bearer abc',
         'https://alice:secret@example.com/repo.git',
      ];
      const snapshot = input.slice();
      const result = classifyHistoryAction(input);

      expect(input).toEqual(snapshot);
      expect(result.originalArgv).toEqual([
         'push',
         '--token=[REDACTED]',
         '--password',
         '[REDACTED]',
         '-c',
         'http.extraHeader=[REDACTED]',
         'https://[REDACTED]@example.com/repo.git',
      ]);
      expect(result.normalizedArgv).not.toContain('top-secret');
      expect(result.originalCommand).not.toContain('hunter2');
      expect(result.originalCommand).not.toContain('bearer abc');
      expect(result.originalCommand).not.toContain('alice');
   });

   it('redacts positional sensitive config values', () => {
      expect(redactHistoryArgv(['config', '--global', 'credential.helper', 'store'])).toEqual([
         'config',
         '--global',
         'credential.helper',
         '[REDACTED]',
      ]);
      expect(redactHistoryArgv(['gdx-config', 'llm.apiKey', 'sk-secret'])).toEqual([
         'gdx-config',
         'llm.apiKey',
         '[REDACTED]',
      ]);
   });

   it('always pairs disposition with the correct enrichment shape', () => {
      const commands: Array<[string[], HistoryDisposition]> = [
         [['status'], 'no-history'],
         [['commit', '-m', 'x'], 'reversible'],
         [['push'], 'audit-only'],
         [['not-a-route'], 'unknown'],
      ];

      for (const [command, disposition] of commands) {
         const result = classifyHistoryAction(command);
         expect(result.disposition).toBe(disposition);
         expect(result.capture === null).toBe(disposition !== 'reversible');
      }
   });
});
