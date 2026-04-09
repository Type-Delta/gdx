/* eslint-disable @typescript-eslint/no-unused-expressions */
import dedent from 'dedent';
import { Bench } from 'tinybench';

import litedent from '@/utils/litedent';

const samples = {
   shortTemplate: `
      alpha
         beta
      gamma
   `,
   longMixedIndent: `
\t    line 1
\t    line 2
\t       line 3
\t    line 4
\t    line 5
\t    line 6
\t    line 7
\t    line 8
\t    line 9
\t    line 10
\t    line 11
\t    line 12
\t       line 13
\t    line 14
\t    line 15
\t    line 16
\t    line 17
\t    line 18
\t    line 19
\t    line 20
   `,
   withInterpolationPrefix: `
      prefix value: ${'x'.repeat(40)}
      line b
      line c
      line d
      line e
   `,
};

type CaseName = keyof typeof samples;

function createBenchForCase(caseName: CaseName, source: string): Bench {
   const bench = new Bench({
      name: `litedent vs dedent (${caseName})`,
      time: 1200,
      warmup: true,
      warmupTime: 250,
   });

   bench.add('dedent(function)', () => {
      dedent(source);
   });

   bench.add('litedent(function)', () => {
      litedent(source);
   });

   bench.add('dedent(tag)', () => {
      dedent`${source}`;
   });

   bench.add('litedent(tag)', () => {
      litedent`${source}`;
   });

   return bench;
}

function getTaskHz(bench: Bench, name: string): number {
   const task = bench.tasks.find((entry) => entry.name === name);
   if (!task || !task.result) {
      throw new Error(`Missing benchmark result for task: ${name}`);
   }

   if (!('throughput' in task.result)) {
      throw new Error(`Task did not produce throughput stats: ${name} (${task.result.state})`);
   }

   return task.result.throughput.mean;
}

function gainPercent(fasterHz: number, slowerHz: number): number {
   return ((fasterHz - slowerHz) / slowerHz) * 100;
}

for (const [caseName, source] of Object.entries(samples) as [CaseName, string][]) {
   const bench = createBenchForCase(caseName, source);
   await bench.run();

   const dedentFnHz = getTaskHz(bench, 'dedent(function)');
   const litedentFnHz = getTaskHz(bench, 'litedent(function)');
   const dedentTagHz = getTaskHz(bench, 'dedent(tag)');
   const litedentTagHz = getTaskHz(bench, 'litedent(tag)');

   const fnGain = gainPercent(litedentFnHz, dedentFnHz);
   const tagGain = gainPercent(litedentTagHz, dedentTagHz);

   console.log(`\nCase: ${caseName}`);
   console.table(bench.table());
   console.log(`litedent(function) vs dedent(function): ${fnGain.toFixed(2)}%`);
   console.log(`litedent(tag) vs dedent(tag): ${tagGain.toFixed(2)}%`);
}
