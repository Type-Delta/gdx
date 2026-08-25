import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'module';
import crypto from 'crypto';
import { execa } from 'execa';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { whichExec } from '@/modules/shell';

const require = createRequire(import.meta.url);
const {
   buildRuntimeShimContents,
   createInstallInfo,
   downloadFile,
   findRuntimeExecutable,
   getNativeBinaryName,
   getNativeBuildArgs,
   overwriteNativeShim,
   overwriteRuntimeShim,
   selectFallbackRuntime,
   verifySha256,
} = require('../../scripts/postinstall.cjs') as {
   buildRuntimeShimContents: (
      runtimeAbsPath: string,
      launcherAbsPath: string,
      runtimeName: 'bun' | 'node'
   ) => {
      cmd: string;
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
   findRuntimeExecutable: (name: string, platform?: NodeJS.Platform) => string | null;
   getNativeBinaryName: (platform?: NodeJS.Platform) => string;
   getNativeBuildArgs: (finalPath: string) => string[];
   overwriteNativeShim: (
      binDir: string,
      nativeAbsPath: string,
      platform?: NodeJS.Platform
   ) => boolean;
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

function runProcess(
   executable: string,
   args: string[],
   options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      input?: Buffer;
   } = {}
): Promise<{ stdout: Buffer; stderr: Buffer; status: number | null }> {
   return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
         cwd: options.cwd,
         env: options.env ?? process.env,
         stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
         windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (status) =>
         resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), status })
      );
      if (options.input !== undefined) child.stdin!.end(options.input);
   });
}

// npm bin entries are symlinks on Unix; the symlink-clobber bug is Unix-only.
const itUnix = process.platform === 'win32' ? it.skip : it;
const sourcePath = path.resolve(import.meta.dir, '../../src/index.ts');
const itWindowsNative = process.platform === 'win32' ? it : it.skip;
const powershell =
   process.platform === 'win32'
      ? ((await whichExec('pwsh', { noCache: true })) ??
         (await whichExec('powershell', { noCache: true })))
      : null;
const itWindowsRuntime = powershell ? it : it.skip;

describe('postinstall runtime fallback shims', () => {
   it('injects a protective separator before forwarded args', () => {
      const shims = buildRuntimeShimContents('/path/to/bun', '/path/to/launcher.cjs', 'bun');

      expect(shims.cmd).toContain('set "GDX_RUNTIME_SHIM=1"');
      expect(shims.cmd).toContain('"/path/to/bun"');
      expect(shims.cmd).toContain('launcher.cjs" -- %*');
      expect(shims.cmd).toContain('set "GDX_RUNTIME_PATH_FALLBACK=1"');
      expect(shims.cmd).toContain("bun -e \"process.stdout.write(process.execPath)\"");
      expect(shims.sh).toContain('export GDX_RUNTIME_SHIM=1');
      expect(shims.sh).toContain('launcher.cjs" -- "$@"');
      expect(shims.sh).toContain('export GDX_RUNTIME_PATH_FALLBACK=1');
      expect(shims.sh).toContain("$(bun -e 'process.stdout.write(process.execPath)')");
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
         expect(fs.existsSync(path.join(binDir, 'gdx.ps1'))).toBe(false);
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });

   it('prefers Bun and falls back to Node', () => {
      expect(selectFallbackRuntime((name) => (name === 'bun' ? '/runtime/bun' : null))).toEqual({
         name: 'bun',
         executable: '/runtime/bun',
      });
      expect(selectFallbackRuntime((name) => (name === 'node' ? '/runtime/node' : null))).toEqual({
         name: 'node',
         executable: '/runtime/node',
      });
   });

   it('resolves a Windows runtime shim from a shell-sensitive path', () => {
      if (process.platform !== 'win32') return;
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx runtime & probe '));
      const oldPath = process.env.PATH;
      try {
         fs.writeFileSync(
            path.join(tmpRoot, 'gdx-runtime-probe.cmd'),
            `@"${process.execPath}" %*\r\n`,
            'utf8'
         );
         process.env.PATH = `${tmpRoot}${path.delimiter}${oldPath ?? ''}`;
         expect(findRuntimeExecutable('gdx-runtime-probe', 'win32')).toBe(process.execPath);
      } finally {
         process.env.PATH = oldPath;
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });

   itWindowsRuntime('finds the runtime on PATH after its recorded location moves', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-runtime-shim-'));
      try {
         const packageRoot = path.join(tmpRoot, 'package');
         const scriptsDir = path.join(packageRoot, 'scripts');
         const distDir = path.join(packageRoot, 'dist');
         fs.mkdirSync(scriptsDir, { recursive: true });
         fs.mkdirSync(distDir, { recursive: true });
         await execa(process.execPath, [
             'build',
             sourcePath,
             '--outfile',
             path.join(distDir, 'index.js'),
             '--target=node',
             '--external=keytar',
             '--external=cspell-lib',
             '--external=@shikijs/cli',
             '--external=shiki',
             '--external=yaml',
             '--external=openai',
             '--external=fflate',
             '--external=diff',
             '--external=@leeoniya/ufuzzy',
             '--format=esm',
             '--production',
             '--keep-names',
          ]);
         const launcherPath = path.join(scriptsDir, 'launcher.cjs');
         fs.copyFileSync(
            path.resolve(import.meta.dir, '../../scripts/launcher.cjs'),
            launcherPath
         );
         const runtime = selectFallbackRuntime();
         overwriteRuntimeShim(
            tmpRoot,
            launcherPath,
            {
               ...runtime,
               executable: path.join(tmpRoot, 'removed-runtime', path.basename(runtime.executable)),
            },
            'win32'
         );
         const shimPath = path.join(tmpRoot, 'gdx.cmd');
         const gitExe = await whichExec('git', { noCache: true });
         if (!gitExe) throw new Error('Git executable not found on Windows.');

         const env: NodeJS.ProcessEnv = { ...process.env, GDX_WRITE_LOGS: '0' };
         delete env.GDX_HISTORY_GUARD;
         delete env.GDX_RUNTIME_SHIM;
         delete env.GDX_NODE_SHIM;
         const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
         const runPowerShell = (command: string) =>
            runProcess(
               powershell!,
               ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
               { cwd: process.cwd(), env }
            );

         const argv = "rev-parse --sq -- 'a b' '--dash' 'quo''te'";
         expect(await runPowerShell(`& ${quote(shimPath)} ${argv}`)).toEqual(
            await runPowerShell(`& ${quote(gitExe)} ${argv}`)
         );

         expect(
            await runPowerShell(`'pipe text' | & ${quote(shimPath)} hash-object --stdin`)
         ).toEqual(
            await runPowerShell(`'pipe text' | & ${quote(gitExe)} hash-object --stdin`)
         );

         const gitOutput = path.join(tmpRoot, 'git.out');
         const shimOutput = path.join(tmpRoot, 'shim.out');
         const gitRedirect = await runPowerShell(
            `& ${quote(gitExe)} rev-parse --is-inside-work-tree > ${quote(gitOutput)}`
         );
         const shimRedirect = await runPowerShell(
            `& ${quote(shimPath)} rev-parse --is-inside-work-tree > ${quote(shimOutput)}`
         );
         expect(shimRedirect).toEqual(gitRedirect);
         expect(fs.readFileSync(shimOutput)).toEqual(fs.readFileSync(gitOutput));

         const failure = 'rev-parse --verify refs/heads/__gdx_missing__';
         expect(await runPowerShell(`& ${quote(shimPath)} ${failure}`)).toEqual(
            await runPowerShell(`& ${quote(gitExe)} ${failure}`)
         );
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   }, 40_000);

   itWindowsNative('keeps the current native gdx.exe entrypoint equivalent to Git', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-native-binary-'));
      try {
         const nativePath = path.join(tmpRoot, 'gdx.exe');
         await execa(process.execPath, [
            'build',
            sourcePath,
            '--outfile',
            nativePath,
            '--compile',
            '--bytecode',
            '--production',
            '--keep-names',
         ]);

         const env: NodeJS.ProcessEnv = { ...process.env, GDX_WRITE_LOGS: '0' };
         delete env.GDX_RUNTIME_SHIM;
         delete env.GDX_NODE_SHIM;
         const gitExe = await whichExec('git', { noCache: true });
         if (!gitExe) throw new Error('Git executable not found on Windows.');

         for (const args of [
            ['rev-parse', '--is-inside-work-tree'],
            ['rev-parse', '--sq', '--', 'a b', '', '--dash', "quo'te"],
            ['rev-parse', '--verify', 'refs/heads/__gdx_missing__'],
         ]) {
            const expected = await runProcess(gitExe, args, {
               cwd: process.cwd(),
               env,
            });
            const actual = await runProcess(nativePath, args, { cwd: process.cwd(), env });
            expect(actual, args.join(' ')).toEqual(expected);
         }

         const input = Buffer.from('native gdx stdin\n\0binary\n');
         const stdinArgs = ['hash-object', '--stdin'];
         expect(
            await runProcess(nativePath, stdinArgs, { cwd: process.cwd(), env, input })
         ).toEqual(await runProcess(gitExe, stdinArgs, { cwd: process.cwd(), env, input }));
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   }, 40_000);
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

   it('does not abort when an existing Windows native entrypoint is locked', async () => {
      if (process.platform !== 'win32') return;
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-locked-shim-'));
      const lockedPath = path.join(tmpRoot, 'gdx.exe');
      fs.copyFileSync(process.execPath, lockedPath);
      const child = spawn(lockedPath, ['-e', 'setInterval(() => {}, 1000)'], {
         stdio: 'ignore',
         windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
         child.once('spawn', resolve);
         child.once('error', reject);
      });

      try {
         expect(overwriteNativeShim(tmpRoot, process.execPath, 'win32')).toBeFalse();
      } finally {
         child.kill();
         await new Promise((resolve) => child.once('close', resolve));
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
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

   it('preserves streams and exit status through its native-binary branch', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gdx-native-launcher-'));
      try {
         const scriptsDir = path.join(tmpRoot, 'scripts');
         const nativeDir = path.join(tmpRoot, 'bin', 'native');
         fs.mkdirSync(scriptsDir, { recursive: true });
         fs.mkdirSync(nativeDir, { recursive: true });
         const launcherPath = path.join(scriptsDir, 'launcher.cjs');
         const nativePath = path.join(
            nativeDir,
            process.platform === 'win32' ? 'gdx.exe' : 'gdx'
         );
         fs.copyFileSync(path.resolve(import.meta.dir, '../../scripts/launcher.cjs'), launcherPath);
         fs.copyFileSync(process.execPath, nativePath);
         fs.chmodSync(nativePath, 0o755);

         const script =
            "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(chunks));process.stderr.write('native stderr\\n');process.exit(7)})";
         const input = Buffer.from('launcher stdin\n\0binary\n');
         expect(
            await runProcess(process.execPath, [launcherPath, '-e', script], {
               cwd: tmpRoot,
               input,
            })
         ).toEqual(await runProcess(nativePath, ['-e', script], { cwd: tmpRoot, input }));
      } finally {
         fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
   });
});
