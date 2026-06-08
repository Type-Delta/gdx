import { describe, expect, it } from 'bun:test';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildNodeShimContents, overwriteNodeShim } = require('../../scripts/postinstall.cjs') as {
   buildNodeShimContents: (nodeAbsPath: string, launcherAbsPath: string) => {
      cmd: string;
      ps1: string;
      sh: string;
   };
   overwriteNodeShim: (binDir: string, launcherAbsPath: string) => boolean;
};

// npm bin entries are symlinks on Unix; the symlink-clobber bug is Unix-only.
const itUnix = process.platform === 'win32' ? it.skip : it;

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

   itUnix('replaces the bin symlink without clobbering the launcher it points to', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-postinstall-'));
      try {
         const launcherPath = path.join(tmpRoot, 'launcher.cjs');
         const launcherSource = '#!/usr/bin/env node\nconsole.log("real launcher");\n';
         fs.writeFileSync(launcherPath, launcherSource, 'utf8');

         // Emulate npm's global bin: <bindir>/gdx -> launcher.cjs symlink.
         const binDir = path.join(tmpRoot, 'bin');
         fs.mkdirSync(binDir);
         const binEntry = path.join(binDir, 'gdx');
         fs.symlinkSync(launcherPath, binEntry);

         expect(overwriteNodeShim(binDir, launcherPath)).toBe(true);

         // The launcher the symlink pointed to must be left intact.
         expect(fs.readFileSync(launcherPath, 'utf8')).toBe(launcherSource);

         // The bin entry must be a fresh regular file holding the shim.
         expect(fs.lstatSync(binEntry).isSymbolicLink()).toBe(false);
         expect(fs.readFileSync(binEntry, 'utf8')).toContain('export GDX_NODE_SHIM=1');
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });
});
