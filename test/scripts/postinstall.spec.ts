import { describe, expect, it } from 'bun:test';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
   buildRuntimeShimContents,
   createInstallInfo,
   downloadFile,
   getNativeBinaryName,
   getNativeBuildArgs,
   overwriteRuntimeShim,
   selectFallbackRuntime,
   verifySha256,
} = require('../../scripts/postinstall.cjs') as {
   buildRuntimeShimContents: (runtimeAbsPath: string, launcherAbsPath: string) => {
      cmd: string;
      ps1: string;
      sh: string;
   };
   createInstallInfo: (mode: string, finalPath: string, useNativeShim: boolean) => {
      mode: string;
      binaryPath: string;
      useNativeShim: boolean;
      platform: string;
      arch: string;
      version: string;
      userAgent: string | null;
      ts: string;
   };
   downloadFile: (url: string, tmpPath: string, destPath: string) => Promise<void>;
   getNativeBinaryName: (platform?: NodeJS.Platform) => string;
   getNativeBuildArgs: (finalPath: string) => string[];
   overwriteRuntimeShim: (
      binDir: string,
      launcherAbsPath: string,
      runtime: { name: string; executable: string },
      platform?: NodeJS.Platform
   ) => boolean;
   selectFallbackRuntime: (
      findExecutable?: (name: string) => string | null
   ) => { name: string; executable: string };
   verifySha256: (filePath: string, checksumText: string, assetName: string) => void;
};
const { getNativeBinaryPath } = require('../../scripts/launcher.cjs') as {
   getNativeBinaryPath: () => string;
};

// npm bin entries are symlinks on Unix; the symlink-clobber bug is Unix-only.
const itUnix = process.platform === 'win32' ? it.skip : it;

describe('postinstall runtime fallback shims', () => {
   it('injects a protective separator before forwarded args', () => {
      const shims = buildRuntimeShimContents('/path/to/bun', '/path/to/launcher.cjs');

      expect(shims.cmd).toContain('set "GDX_RUNTIME_SHIM=1"');
      expect(shims.cmd).toContain('"/path/to/bun"');
      expect(shims.cmd).toContain('launcher.cjs" -- %*');
      expect(shims.ps1).toContain('$env:GDX_RUNTIME_SHIM = "1"');
      expect(shims.ps1).toContain('launcher.cjs" -- @args');
      expect(shims.ps1).not.toContain('$MyInvocation.Line');
      expect(shims.sh).toContain('export GDX_RUNTIME_SHIM=1');
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

         expect(
            overwriteRuntimeShim(binDir, launcherPath, {
               name: 'bun',
               executable: '/path/to/bun',
            })
         ).toBe(true);

         // The launcher the symlink pointed to must be left intact.
         expect(fs.readFileSync(launcherPath, 'utf8')).toBe(launcherSource);

         // The bin entry must be a fresh regular file holding the shim.
         expect(fs.lstatSync(binEntry).isSymbolicLink()).toBe(false);
         expect(fs.readFileSync(binEntry, 'utf8')).toContain('export GDX_RUNTIME_SHIM=1');
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });

   it('writes an extensionless shim for Git Bash on Windows', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-postinstall-win-shim-'));
      try {
         const binDir = path.join(tmpRoot, 'bin');
         const launcherPath = path.join(tmpRoot, 'launcher.cjs');
         fs.mkdirSync(binDir);
         fs.writeFileSync(launcherPath, '#!/usr/bin/env node\n', 'utf8');

         expect(
            overwriteRuntimeShim(
               binDir,
               launcherPath,
               {
                  name: 'bun',
                  executable: 'C:\\Users\\runneradmin\\.bun\\bin\\bun.exe',
               },
               'win32'
            )
         ).toBe(true);

         expect(fs.readFileSync(path.join(binDir, 'gdx'), 'utf8')).toContain(
            'export GDX_RUNTIME_SHIM=1'
         );
         expect(fs.readFileSync(path.join(binDir, 'gdx.cmd'), 'utf8')).toContain(
            'set "GDX_RUNTIME_SHIM=1"'
         );
         expect(fs.readFileSync(path.join(binDir, 'gdx.ps1'), 'utf8')).toContain(
            '$env:GDX_RUNTIME_SHIM = "1"'
         );
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });

   it('prefers bun then the installing Node executable', () => {
      expect(selectFallbackRuntime((name) => (name === 'bun' ? '/runtime/bun' : null))).toEqual({
         name: 'bun',
         executable: '/runtime/bun',
      });
      expect(selectFallbackRuntime(() => null)).toEqual({
         name: 'node',
         executable: process.execPath,
      });
   });
});

describe('postinstall prebuilt helpers', () => {
   it('downloads to a temporary path before renaming to the final destination', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-postinstall-download-'));
      const originalFetch = globalThis.fetch;
      try {
         const tmpPath = path.join(tmpRoot, 'asset.tmp');
         const destPath = path.join(tmpRoot, 'asset.exe');

         globalThis.fetch = (async () => {
            return new Response('binary-data', { status: 200 });
         }) as unknown as typeof fetch;

         await downloadFile('https://example.test/asset.exe', tmpPath, destPath);

         expect(fs.existsSync(tmpPath)).toBe(false);
         expect(fs.readFileSync(destPath, 'utf8')).toBe('binary-data');
      } finally {
         globalThis.fetch = originalFetch;
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });

   it('verifies SHA256 checksums before install', () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-postinstall-sha-'));
      try {
         const filePath = path.join(tmpRoot, 'asset.exe');
         fs.writeFileSync(filePath, 'binary-data');
         const hash = crypto.createHash('sha256').update('binary-data').digest('hex');

         expect(() => verifySha256(filePath, `${hash}  asset.exe`, 'asset.exe')).not.toThrow();
         expect(() => verifySha256(filePath, `${'0'.repeat(64)}  asset.exe`, 'asset.exe')).toThrow(
            'Checksum mismatch'
         );
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });
});

describe('postinstall native build helpers', () => {
   it('should derive platform-specific native binary names', () => {
      expect(getNativeBinaryName('win32')).toBe('gdx.exe');
      expect(getNativeBinaryName('linux')).toBe('gdx');
      expect(getNativeBinaryName('darwin')).toBe('gdx');
   });

   it('should build native Bun compile args for the selected output path', () => {
      const args = getNativeBuildArgs('/tmp/gdx-native');

      expect(args).toContain('build');
      expect(args.some((arg) => path.normalize(arg).endsWith(path.normalize('dist/index.js')))).toBe(true);
      expect(args).toContain('--outfile=/tmp/gdx-native');
      expect(args).toContain('--compile');
      expect(args).toContain('--bytecode');
      expect(args).toContain('--production');
      expect(args).toContain('--keep-names');
   });

   it('should create install-info records for native installs', () => {
      const info = createInstallInfo('built', '/tmp/gdx-native', true);

      expect(info.mode).toBe('built');
      expect(info.binaryPath).toBe('/tmp/gdx-native');
      expect(info.useNativeShim).toBe(true);
      expect(info.platform).toBe(process.platform);
      expect(info.arch).toBe(process.arch);
      expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
   });
});

describe('launcher', () => {
   it('looks for the native binary under bin/native', () => {
      const expected = path.normalize(
         path.join(
            import.meta.dir,
            '../../bin/native',
            process.platform === 'win32' ? 'gdx.exe' : 'gdx'
         )
      );
      expect(path.normalize(getNativeBinaryPath())).toBe(expected);
   });
});
