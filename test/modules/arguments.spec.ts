import { describe, expect, it } from 'bun:test';

import global from '@/global';
import { ArgsSet, argsSet, getValueFromOption, stripGitGlobalArgs } from '@/modules/arguments';

describe('ArgsSet', () => {
   function withIndexModes(run: (enabled: boolean) => void): void {
      for (const enabled of [true, false]) {
         const previous = global.indexArgs;
         global.indexArgs = enabled;
         try {
            run(enabled);
         } finally {
            global.indexArgs = previous;
         }
      }
   }

   it('creates ArgsSet from helper', () => {
      const result = argsSet(['status', '--short']);

      expect(result).toBeInstanceOf(ArgsSet);
      expect(result.toArray()).toEqual(['status', '--short']);
   });

   it('returns ArgsSet when sliced', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['a', 'b', 'c']);
         const result = args.slice(1);

         expect(result).toBeInstanceOf(ArgsSet);
         expect(result.toArray()).toEqual(['b', 'c']);
      });
   });

   it('returns a cloned array via toArray', () => {
      const args = new ArgsSet(['a', 'b']);
      const array = args.toArray();
      array.push('c');

      expect(args.toArray()).toEqual(['a', 'b']);
      expect(array).toEqual(['a', 'b', 'c']);
   });

   it('optionIndexOf finds exact and equals forms before terminator', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--depth=1', '--jobs', '4', '--', '--depth=2']);

         expect(args.optionIndexOf('--depth')).toBe(0);
         expect(args.optionIndexOf('--jobs')).toBe(1);
         expect(args.optionIndexOf('--depth', 1)).toBe(-1);
      });
   });

   it('optionIndexOf supports from offsets including negative values', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--x', '--y', '--z']);

         expect(args.optionIndexOf('--x', -100)).toBe(0);
         expect(args.optionIndexOf('--y', -2)).toBe(1);
         expect(args.optionIndexOf('--y', 10)).toBe(-1);
      });
   });

   it('hasOption mirrors optionIndexOf behavior', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--author=me', '--', '--author=after']);

         expect(args.hasOption('--author')).toBe(true);
         expect(args.hasOption('--author', 1)).toBe(false);
      });
   });

   it('delete removes a found option and reports correctly', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--quiet', 'status']);

         expect(args.delete('--quiet')).toBe(true);
         expect(args.toArray()).toEqual(['status']);
         expect(args.delete('--quiet')).toBe(false);
      });
   });

   it('popOption removes option token and returns removed token', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--depth=1', 'status']);

         expect(args.popOption('--depth')).toBe('--depth=1');
         expect(args.toArray()).toEqual(['status']);
         expect(args.popOption('--depth')).toBeNull();
      });
   });

   it('spliceOption replaces option token with provided values', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['push', '-fl', 'origin']);

         expect(args.spliceOption('-fl', ['--force-with-lease'])).toBe(true);
         expect(args.toArray()).toEqual(['push', '--force-with-lease', 'origin']);
         expect(args.spliceOption('-fl', ['--force'])).toBe(false);
      });
   });

   it('popValue handles equals, split value, missing, and missing arg', () => {
      withIndexModes(() => {
         const equals = new ArgsSet(['--depth=1']);
         expect(equals.popValue('--depth')).toBe('1');
         expect(equals.toArray()).toEqual([]);

         const split = new ArgsSet(['--depth', '2', 'status']);
         expect(split.popValue('--depth')).toBe('2');
         expect(split.toArray()).toEqual(['status']);

         const missingValue = new ArgsSet(['--depth', '--jobs=4']);
         expect(missingValue.popValue('--depth')).toBeNull();
         expect(missingValue.toArray()).toEqual(['--jobs=4']);

         const missingOption = new ArgsSet(['status']);
         expect(missingOption.popValue('--depth')).toBeNull();
         expect(missingOption.toArray()).toEqual(['status']);
      });
   });

   it('popValue treats numeric negative next token as value', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--depth', '-1', '--jobs=4']);

         expect(args.popValue('--depth')).toBe('-1');
         expect(args.toArray()).toEqual(['--jobs=4']);
      });
   });

   it('popValue valSameIdxOnly removes flag but not next token', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--depth', '3', 'status']);

         expect(args.popValue('--depth', 0, true)).toBeNull();
         expect(args.toArray()).toEqual(['3', 'status']);
      });
   });

   it('popAssertValue throws for missing value but returns null when arg absent', () => {
      withIndexModes(() => {
         const missingValue = new ArgsSet(['--depth', '--jobs=4']);
         expect(() => missingValue.popAssertValue('--depth')).toThrow(
            'requires a value, but none was provided'
         );

         const missingOption = new ArgsSet(['status']);
         expect(missingOption.popAssertValue('--depth')).toBeNull();
      });
   });

   it('supports array mutation APIs while keeping query behavior stable', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['--a', 'x', '--b=2']);
         args.push('--c=3');
         args.unshift('--start');
         args.shift();
         args.pop();
         args.splice(1, 0, '--inserted');
         args.reverse();
         args.sort();
         args.fill('--fill', 0, 1);
         args.copyWithin(1, 0, 1);

         expect(args.hasOption('--fill')).toBe(true);
         expect(args.optionIndexOf('--fill')).toBeGreaterThanOrEqual(0);
      });
   });

   it('indexOf handles from offsets like native arrays', () => {
      withIndexModes(() => {
         const args = new ArgsSet(['a', 'b', 'a']);

         expect(args.indexOf('a')).toBe(0);
         expect(args.indexOf('a', 1)).toBe(2);
         expect(args.indexOf('a', -1)).toBe(2);
         expect(args.indexOf('a', 5)).toBe(-1);
      });
   });
});

describe('getValueFromOption', () => {
   it('extracts value after first equals', () => {
      expect(getValueFromOption('--name=value')).toBe('value');
      expect(getValueFromOption('--name=a=b')).toBe('a=b');
      expect(getValueFromOption('--name=')).toBe('');
   });

   it('returns null when no separator exists', () => {
      expect(getValueFromOption('--name')).toBeNull();
   });
});

describe('stripGitGlobalArgs', () => {
   it('skips stripping when first arg is not a flag', () => {
      const result = stripGitGlobalArgs(['status', '-s'], 1);

      expect(result.args).toEqual(['status', '-s']);
      expect(result.gitArgs).toEqual([]);
      expect(result.cursorIndex).toBe(1);
      expect(result.cursorInGitGlobal).toBe(false);
   });

   it('strips leading git global options', () => {
      const result = stripGitGlobalArgs(['-C', 'repo', 'status']);

      expect(result.args).toEqual(['status']);
      expect(result.gitArgs).toEqual(['-C', 'repo']);
      expect(result.cursorInGitGlobal).toBe(false);
   });

   it('supports equals and compact short value forms', () => {
      const equalsResult = stripGitGlobalArgs(['--git-dir=.git', 'status']);
      expect(equalsResult.args).toEqual(['status']);
      expect(equalsResult.gitArgs).toEqual(['--git-dir', '.git']);

      const shortResult = stripGitGlobalArgs(['-Crepo', 'status']);
      expect(shortResult.args).toEqual(['status']);
      expect(shortResult.gitArgs).toEqual(['-C', 'repo']);
   });

   it('stops scanning at first non-option command token', () => {
      const result = stripGitGlobalArgs(['-C', 'repo', 'status', '--git-dir=.git']);

      expect(result.args).toEqual(['status', '--git-dir=.git']);
      expect(result.gitArgs).toEqual(['-C', 'repo']);
   });

   it('stops scanning at option terminator', () => {
      const result = stripGitGlobalArgs(['-C', 'repo', '--', '--git-dir=.git']);

      expect(result.args).toEqual(['--', '--git-dir=.git']);
      expect(result.gitArgs).toEqual(['-C', 'repo']);
   });

   it('marks cursor within git global option and preserves args', () => {
      const result = stripGitGlobalArgs(['-C', 'repo', 'status'], 1);

      expect(result.args).toEqual(['-C', 'repo', 'status']);
      expect(result.gitArgs).toEqual([]);
      expect(result.cursorIndex).toBe(1);
      expect(result.cursorInGitGlobal).toBe(true);
   });

   it('keeps option under cursor unstripped while removing prior globals', () => {
      const result = stripGitGlobalArgs(['-C', 'repo', '--git-dir=.git', 'status'], 2);

      expect(result.args).toEqual(['-C', 'repo', '--git-dir=.git', 'status']);
      expect(result.gitArgs).toEqual([]);
      expect(result.cursorIndex).toBe(2);
      expect(result.cursorInGitGlobal).toBe(true);
   });

   it('does not strip incomplete git global options requiring values', () => {
      const result = stripGitGlobalArgs(['-C']);

      expect(result.args).toEqual(['-C']);
      expect(result.gitArgs).toEqual([]);
      expect(result.cursorInGitGlobal).toBe(false);
   });
});
