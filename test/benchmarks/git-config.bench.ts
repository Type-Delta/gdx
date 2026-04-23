import { Bench } from 'tinybench';

import { getConfig } from '@/common/config';
import { getGitConfigValue } from '@/modules/git';
import { createGdxContext, createTestEnv, setTestGitConfig } from '@/utils/testHelper';

const BENCH_TIME_MS = 1600;
const WARMUP_TIME_MS = 400;
const CONFIG_KEY = 'user.email';
const EXPECTED_VALUE = 'bench@example.com';

async function setInlineMode(mode: 'off' | 'internal'): Promise<void> {
   const config = await getConfig();
   await config.set('useInlineGitConfig', mode);
   await config.save();
}

async function runSingleBench(name: string, fn: () => Promise<void>): Promise<number> {
   await fn();

   const bench = new Bench({
      name,
      time: BENCH_TIME_MS,
      warmup: true,
      warmupTime: WARMUP_TIME_MS,
   });

   bench.add(name, async () => {
      await fn();
   });

   await bench.run();
   const task = bench.tasks[0];
   if (!task?.result || !(task.result as { throughput?: { mean?: number } }).throughput?.mean) {
      throw new Error(`Benchmark task '${name}' did not produce throughput stats.`);
   }

   const hz = (task.result as { throughput: { mean: number } }).throughput.mean;
   console.log(`\n${name}`);
   console.table(bench.table());
   return hz;
}

function fmtHz(value: number): string {
   return `${value.toFixed(2)} ops/s`;
}

export async function runGitConfigBenchmark(): Promise<void> {
   const { tmpDir: repoPath, $, cleanup } = await createTestEnv({
      autoResetBuffer: false,
      suitName: 'bench-git-config',
      initTestHarness: false,
   });
   const { git$ } = createGdxContext(repoPath, []);

   await setTestGitConfig(repoPath, 'user.email', EXPECTED_VALUE);

   try {
      await setInlineMode('off');
      const offHz = await runSingleBench('inline git config (useInlineGitConfig=off)', async () => {
         const value = await getGitConfigValue(git$, CONFIG_KEY, repoPath);
         if (value !== EXPECTED_VALUE) {
            throw new Error(
               `Unexpected value for ${CONFIG_KEY}. Expected '${EXPECTED_VALUE}', got '${value}'.`
            );
         }
      });

      await setInlineMode('internal');
      const internalHz = await runSingleBench(
         'inline git config (useInlineGitConfig=internal)',
         async () => {
            const value = await getGitConfigValue(git$, CONFIG_KEY, repoPath);
            if (value !== EXPECTED_VALUE) {
               throw new Error(
                  `Unexpected value for ${CONFIG_KEY}. Expected '${EXPECTED_VALUE}', got '${value}'.`
               );
            }
         }
      );

      const directHz = await runSingleBench('direct git executable (git config)', async () => {
         const value = (await $`${git$} config ${CONFIG_KEY}`).stdout.trim();
         if (value !== EXPECTED_VALUE) {
            throw new Error(
               `Unexpected value for ${CONFIG_KEY}. Expected '${EXPECTED_VALUE}', got '${value}'.`
            );
         }
      });

      const summary = [
         {
            method: 'inline (off)',
            throughput: fmtHz(offHz),
            versusDirect: `${(offHz / directHz).toFixed(2)}x`,
         },
         {
            method: 'inline (internal)',
            throughput: fmtHz(internalHz),
            versusDirect: `${(internalHz / directHz).toFixed(2)}x`,
         },
         {
            method: 'direct git executable',
            throughput: fmtHz(directHz),
            versusDirect: '1.00x',
         },
      ];

      console.log('\nGit config benchmark summary');
      console.table(summary);

      if (internalHz <= directHz) {
         throw new Error(
            `Expected internal mode to be faster than direct git executable, but got ${fmtHz(internalHz)} vs ${fmtHz(directHz)}.`
         );
      }

      console.log(
         `\nPASS: internal mode is faster than direct git executable (${(internalHz / directHz).toFixed(2)}x).`
      );
   } finally {
      cleanup();
   }
}

await runGitConfigBenchmark();
