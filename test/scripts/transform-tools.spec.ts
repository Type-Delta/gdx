import { describe, expect, it } from 'bun:test';
import { transformAsync } from '@babel/core';

import { transformToolsToTreeShakeable } from '../../scripts/transform-tools.mjs';

async function transformFixture(source: string): Promise<string> {
   const result = await transformAsync(source, {
      plugins: [(api: unknown) => transformToolsToTreeShakeable(api)],
      configFile: false,
      babelrc: false,
      generatorOpts: { compact: false },
   });

   return result?.code || '';
}

describe('transform-tools', () => {
   it('should export regular Tools methods and rewrite internal Tools references', async () => {
      const code = await transformFixture(`
         const _modules = {};
         const Tools = {
            _modules,
            first(value) {
               return Tools.second(value) + 1;
            },
            second: (value) => value * 2,
         };
         if (typeof module !== 'undefined') module.exports = Tools;
         if (typeof window !== 'undefined') window._tools = Tools;
      `);

      expect(code).toContain('export function first');
      expect(code).toContain('export const second');
      expect(code).toContain('return second(value) + 1');
      expect(code).toContain('export default Tools');
      expect(code).not.toContain('module.exports');
      expect(code).not.toContain('window._tools');
   });

   it('should fail loudly for unsupported top-level Tools member shapes', async () => {
      let thrown: unknown;
      try {
         await transformFixture(`
            const name = 'value';
            const Tools = {
               [name]: 1,
            };
         `);
      } catch (error) {
         thrown = error;
      }

      expect(String(thrown)).toContain('unsupported Tools member shape');
   });
});
