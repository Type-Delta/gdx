/* eslint-disable no-undef */
import { Bench } from 'tinybench';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const tools_old = require('./_tools.cjs');
const tools_new = (await import('../../../lib/esm/Tools.js')).default;

// const test_str = fs.readFileSync('./test/dev/tools-bench/_tools.cjs', 'utf-8');
const normal_test_str = fs.readFileSync('./test/commands/commit.spec.ts', 'utf-8');

const bench = new Bench({ time: 2000 });
bench.add('strWrap() (old, redundancyLv: 0)', () => {
   tools_old.strWrap(normal_test_str, 50, { redundancyLv: 0 });
});
bench.add('strWrap() (old, redundancyLv: 1)', () => {
   tools_old.strWrap(normal_test_str, 50, { redundancyLv: 1 });
});
bench.add('strWrap() (old, redundancyLv: 2)', () => {
   tools_old.strWrap(normal_test_str, 50, { redundancyLv: 2 });
});

bench.add('strWrap() (new, redundancyLv: 0)', () => {
   tools_new.strWrap(normal_test_str, 50, { redundancyLv: 0 });
});

bench.add('strWrap() (new, redundancyLv: 1)', () => {
   tools_new.strWrap(normal_test_str, 50, { redundancyLv: 1 });
});

bench.add('strWrap() (new, redundancyLv: 2)', () => {
   tools_new.strWrap(normal_test_str, 50, { redundancyLv: 2 });
});

await bench.run();

console.log('Normal Test: (medium length string)');
console.table(bench.table());

const long_test_str = fs.readFileSync(path.join(__dirname, '_tools.cjs'), 'utf-8');

const bench_long = new Bench({ time: 2000 });
bench_long.add('strWrap() (old, redundancyLv: 0)', () => {
   tools_old.strWrap(long_test_str, 50, { redundancyLv: 0 });
});
bench_long.add('strWrap() (old, redundancyLv: 1)', () => {
   tools_old.strWrap(long_test_str, 50, { redundancyLv: 1 });
});
bench_long.add('strWrap() (old, redundancyLv: 2)', () => {
   tools_old.strWrap(long_test_str, 50, { redundancyLv: 2 });
});

bench_long.add('strWrap() (new, redundancyLv: 0)', () => {
   tools_new.strWrap(long_test_str, 50, { redundancyLv: 0 });
});

bench_long.add('strWrap() (new, redundancyLv: 1)', () => {
   tools_new.strWrap(long_test_str, 50, { redundancyLv: 1 });
});

bench_long.add('strWrap() (new, redundancyLv: 2)', () => {
   tools_new.strWrap(long_test_str, 50, { redundancyLv: 2 });
});

await bench_long.run();

console.log('Long Test: (long/complex string)');
console.table(bench_long.table());
