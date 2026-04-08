import { Bench } from 'tinybench';

import global from '@/global';
import { ArgsSet } from '@/modules/arguments';

const args = [
   '--quiet',
   'aaa',
   '--single-branch',
   '--filter=blob:none',
   '-b',
   '-e=eee',
   '--depth=1',
   'bbb',
   '--recurse-submodules',
   '--shallow-submodules',
   '--jobs=3',
   '--',
   '--jobs=4',
   'ccc',
];

const lookupHeavyArgs = [
   ...args,
   ...Array.from({ length: 240 }, (_, i) => `--no-op-${i}=v${i}`),
   '--no-op-2=v2b',
   '--no-op-190=v190b',
   '--no-op-239=v239b',
];

const mutationHeavyArgs = [
   ...args,
   '--author=alice',
   '--message',
   'initial commit',
   '--count',
   '-1',
   '--allow-empty',
   '--amend',
   '--no-edit',
];

function addCompatibilityScenarios(bench: Bench, source: ArgsSet): void {
   bench.add('popAssertValue', () => {
      const as = source.slice();
      as.popAssertValue('--filter');
      as.popAssertValue('--depth');
      as.popAssertValue('--jobs');
   });

   bench.add('optionIndexOf', () => {
      source.optionIndexOf('--filter');
      source.optionIndexOf('--depth');
      source.optionIndexOf('--jobs');
   });

   bench.add('hasOption', () => {
      source.hasOption('-e');
      source.hasOption('-b');
      source.hasOption('--jobs');
   });

   bench.add('delete', () => {
      const as = source.slice();
      as.delete('aaa');
      as.delete('--recurse-submodules');
      as.delete('--jobs=3');
   });

   bench.add('popValue', () => {
      const as = source.slice();
      as.popValue('--filter');
      as.popValue('--depth');
      as.popValue('--jobs');
   });

   bench.add('popOption', () => {
      const as = source.slice();
      as.popOption('--filter');
      as.popOption('--depth');
      as.popOption('--jobs');
   });

   bench.add('spliceOptions', () => {
      const as = source.slice();
      as.spliceOption('--filter', ['--filter=blob:none', '--filter=tree:0']);
      as.spliceOption('--depth', ['--depth=1', '--depth=2']);
      as.spliceOption('--jobs', ['--jobs=3', '--jobs=4']);
   });

   bench.add('indexOf', () => {
      source.indexOf('bbb');
      source.indexOf('--depth=1');
      source.indexOf('--jobs=3');
   });
}

function addRealWorldScenarios(bench: Bench): void {
   const as1 = new ArgsSet(lookupHeavyArgs);
   bench.add('lookup-heavy (simulated CLI dispatch)', () => {
      as1.hasOption('--no-op-239');
      as1.optionIndexOf('--no-op-190');
      as1.optionIndexOf('--single-branch');
      as1.hasOption('--filter');
      as1.hasOption('--no-op-2');
      as1.indexOf('--no-op-120=v120');
      as1.indexOf('--no-op-239=v239');
   });

   bench.add('mutation-heavy (simulated command rewrite)', () => {
      const as = new ArgsSet(mutationHeavyArgs);
      as.popValue('--message');
      as.popValue('--count');
      as.popOption('--allow-empty');
      as.spliceOption('--single-branch', ['--single-branch', '--dry-run']);
      as.unshift('--trace');
      as.push('--verbose');
      as.delete('--quiet');
   });
}

async function runBench(indexEnabled: boolean): Promise<Bench> {
   global.indexArgs = indexEnabled;

   const source = new ArgsSet(args);
   const bench = new Bench({
      name: indexEnabled ? 'Arguments with index' : 'Arguments without index',
      time: 1000,
   });

   addCompatibilityScenarios(bench, source);
   addRealWorldScenarios(bench);

   await bench.run();
   return bench;
}

const previousIndexArgs = global.indexArgs;

try {
   const withIndex = await runBench(true);
   const withoutIndex = await runBench(false);

   console.log('Arguments with index:');
   console.table(withIndex.table());

   console.log('Arguments without index:');
   console.table(withoutIndex.table());
} finally {
   global.indexArgs = previousIndexArgs;
}
