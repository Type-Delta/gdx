import { describe, expect, it } from 'bun:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildNodeShimContents } = require('../../scripts/postinstall.cjs') as {
   buildNodeShimContents: (nodeAbsPath: string, launcherAbsPath: string) => {
      cmd: string;
      ps1: string;
      sh: string;
   };
};

describe('postinstall node fallback shims', () => {
   it('injects a protective separator before forwarded args', () => {
      const shims = buildNodeShimContents('/path/to/node', '/path/to/launcher.cjs');

      expect(shims.cmd).toContain('set "GDX_NODE_SHIM=1"');
      expect(shims.cmd).toContain('launcher.cjs" -- %*');
      expect(shims.ps1).toContain('$env:GDX_NODE_SHIM = "1"');
      expect(shims.ps1).toContain('launcher.cjs" -- @args');
      expect(shims.ps1).not.toContain('$MyInvocation.Line');
      expect(shims.sh).toContain('export GDX_NODE_SHIM=1');
      expect(shims.sh).toContain('launcher.cjs" -- "$@"');
   });
});
