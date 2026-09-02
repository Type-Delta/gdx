import { describe, expect } from 'bun:test';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import pkg from '../../package.json';

import doctor from '@/commands/doctor';
import { resetConfig } from '@/common/config';
import global from '@/global';
import * as fs from '@/modules/fs';
import { createTestEnv } from '@/utils/testHelper';
import { runPostInstallDiagnostics } from '../postinstall.validator';

describe('gdx doctor', async () => {
   const { tmpRootDir, buffer, it } = await createTestEnv({ suitName: 'doctor' });
   const originalArgv1 = process.argv[1];

   /** Writes the global secret-store setting used by the doctor command. */
   const writeSecretStoreConfig = (provider: 'auto' | 'keychain' | 'pass') => {
      fs.writeFileSync(
         process.env.GDX_CONFIG_PATH!,
         `[security]\nsecretStore = "${provider}"\n`,
         'utf8'
      );
      resetConfig();
   };

   const writeInstallInfo = (version: string, shimInstalled = false) => {
      const nativeDir = path.join(tmpRootDir, 'native');
      const scriptsDir = path.join(tmpRootDir, 'scripts');
      const workersDir = path.join(tmpRootDir, 'dist/workers');
      const diagnosticsDir = path.join(tmpRootDir, 'dist/diagnostics');
      for (const directory of [nativeDir, scriptsDir, workersDir, diagnosticsDir]) {
         fs.mkdirSync(directory, { recursive: true });
      }
      fs.writeFileSync(path.join(tmpRootDir, 'package.json'), JSON.stringify(pkg));
      fs.writeFileSync(path.join(scriptsDir, 'launcher.cjs'), '');
      fs.writeFileSync(path.join(scriptsDir, 'postinstall.cjs'), '');
      fs.writeFileSync(path.join(tmpRootDir, 'dist/index.js'), '');
      fs.writeFileSync(path.join(workersDir, 'generic.worker.min.js'), '');
      fs.writeFileSync(
         path.join(diagnosticsDir, 'postinstall.validator.js'),
         `export { runPostInstallDiagnostics } from ${JSON.stringify(
            pathToFileURL(path.resolve(import.meta.dir, '../postinstall.validator.ts')).href
         )};\n`
      );
      fs.writeFileSync(
         path.join(nativeDir, 'install.json'),
         JSON.stringify({
            mode: 'runtime',
            runtime: 'bun',
            platform: process.platform,
            arch: process.arch,
            version,
            useGlobalShim: shimInstalled,
            useLocalShim: false,
            shimLimitations: shimInstalled
               ? [
                  'powershell-empty-arguments',
                  'powershell-percent-expansion',
                  'powershell-cmd-metacharacters',
               ]
               : [],
         })
      );
      process.argv[1] = path.join(tmpRootDir, 'gdx.cjs');
      writeHealthyKeytarStub();
   };

   /** Creates a local keytar package with an isolated in-process password value. */
   const writeHealthyKeytarStub = () => {
      const keytarDir = path.join(tmpRootDir, 'node_modules/keytar');
      fs.mkdirSync(keytarDir, { recursive: true });
      fs.writeFileSync(
         path.join(keytarDir, 'package.json'),
         JSON.stringify({ name: 'keytar', type: 'module', exports: './index.js' })
      );
      fs.writeFileSync(
         path.join(keytarDir, 'index.js'),
         `let password = null;
export default {
   async setPassword(_service, _account, value) { password = value; },
   async getPassword() { return password; },
   async deletePassword() { const existed = password !== null; password = null; return existed; }
};\n`
      );
   };

   /** Creates a local keytar package whose keychain operations fail predictably. */
   const writeFailingKeytarStub = () => {
      const keytarDir = path.join(tmpRootDir, 'node_modules/keytar');
      fs.mkdirSync(keytarDir, { recursive: true });
      fs.writeFileSync(
         path.join(keytarDir, 'package.json'),
         JSON.stringify({ name: 'keytar', type: 'module', exports: './index.js' })
      );
      fs.writeFileSync(
         path.join(keytarDir, 'index.js'),
         `export default {
   async setPassword() { throw new Error('headless keychain unavailable'); },
   async getPassword() { return null; },
   async deletePassword() { return false; }
};\n`
      );
   };

   /** Creates a disposable pass stand-in that records argv separately from stdin. */
   const writePassStub = (shouldFail = false) => {
      const binDir = path.join(tmpRootDir, 'fake-pass-bin');
      const executable = path.join(binDir, 'pass');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
         executable,
         shouldFail
            ? '#!/bin/sh\nexit 23\n'
            : `#!/bin/sh
printf '%s\\n' "$*" >> "$GDX_TEST_PASS_ARGV"
case "$1" in
   insert) cat > "$GDX_TEST_PASS_STORE" ;;
   show) cat "$GDX_TEST_PASS_STORE" ;;
   rm) rm -f "$GDX_TEST_PASS_STORE" ;;
   *) exit 24 ;;
esac
`
      );
      chmodSync(executable, 0o755);
      return binDir;
   };

   it('reports a healthy installation with passing checks', async () => {
      writeInstallInfo(pkg.version);

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('Post-install integration checks:');
         expect(buffer.stdout).toContain('PASS Required artifacts');
         expect(buffer.stdout).toContain('Configured provider: auto; selected provider: keychain');
      } finally {
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });

   it('reports the configured provider when native probing is unavailable', async () => {
      writeInstallInfo(pkg.version);

      const results = await runPostInstallDiagnostics({
         packageRoot: tmpRootDir,
         installInfo: {
            mode: 'native',
            version: pkg.version,
            platform: process.platform,
            arch: process.arch,
            useNativeShim: true,
         },
         isNative: true,
         shimActive: false,
         shimPathFallback: false,
         secretStoreProvider: 'pass',
      });

      expect(results).toContainEqual({
         name: 'Secret storage',
         status: 'warn',
         detail:
            'Configured provider: pass. The standalone native diagnostic cannot run a disposable secret-store probe.',
      });
   });

   it('reports mismatched installation metadata', async () => {
      writeInstallInfo('0.0.0');

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(1);
         expect(buffer.stdout).toContain('FAIL Install metadata');
         expect(buffer.stdout).toContain('Mismatched version');
      } finally {
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });

   it('recognizes the runtime shim after startup consumes its marker', async () => {
      writeInstallInfo(pkg.version, true);
      const originalShimActive = global.runtimeShimActive;
      global.runtimeShimActive = true;

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('WARN Command shim');
         expect(buffer.stdout).toContain('powershell-cmd-metacharacters');
      } finally {
         global.runtimeShimActive = originalShimActive;
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });

   it('warns when the shim must rediscover a moved runtime on PATH', async () => {
      writeInstallInfo(pkg.version, true);
      const originalShimActive = global.runtimeShimActive;
      const originalPathFallback = global.runtimeShimPathFallback;
      global.runtimeShimActive = true;
      global.runtimeShimPathFallback = true;

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('WARN Command shim');
         expect(buffer.stdout).toContain('each launch resolves it through PATH');
         expect(buffer.stdout).toContain('Reinstall gdx');
      } finally {
         global.runtimeShimActive = originalShimActive;
         global.runtimeShimPathFallback = originalPathFallback;
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });

   it('reports pass as the effective Linux secret store when keytar fails', async () => {
      if (process.platform !== 'linux') return;

      writeInstallInfo(pkg.version);
      writeFailingKeytarStub();
      const fakeBinDir = writePassStub();
      const passStore = path.join(tmpRootDir, 'pass-probe-secret');
      const passArgv = path.join(tmpRootDir, 'pass-probe-argv');
      const originalPath = process.env.PATH;
      const originalPassStore = process.env.GDX_TEST_PASS_STORE;
      const originalPassArgv = process.env.GDX_TEST_PASS_ARGV;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
      process.env.GDX_TEST_PASS_STORE = passStore;
      process.env.GDX_TEST_PASS_ARGV = passArgv;

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('PASS Secret storage');
         expect(buffer.stdout).toContain('Configured provider: auto; selected provider: pass');
         expect(buffer.stdout).toContain('Keytar failed: headless keychain unavailable');
         expect(buffer.stdout).toContain('pass passed its round-trip test');
         expect(fs.existsSync(passStore)).toBe(false);
         expect(fs.readFileSync(passArgv, 'utf8')).not.toContain('gdx-keychain-round-trip');
      } finally {
         if (originalPath === undefined) delete process.env.PATH;
         else process.env.PATH = originalPath;
         if (originalPassStore === undefined) delete process.env.GDX_TEST_PASS_STORE;
         else process.env.GDX_TEST_PASS_STORE = originalPassStore;
         if (originalPassArgv === undefined) delete process.env.GDX_TEST_PASS_ARGV;
         else process.env.GDX_TEST_PASS_ARGV = originalPassArgv;
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });

   it('explains when neither keytar nor the Linux pass fallback works', async () => {
      if (process.platform !== 'linux') return;

      writeInstallInfo(pkg.version);
      writeFailingKeytarStub();
      const fakeBinDir = writePassStub(true);
      const originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('WARN Secret storage');
         expect(buffer.stdout).toContain('Configured provider: auto; selected provider: pass');
         expect(buffer.stdout).toContain('Keytar failed: headless keychain unavailable');
         expect(buffer.stdout).toContain('pass probe failed: pass insert failed with exit code 23');
      } finally {
         if (originalPath === undefined) delete process.env.PATH;
         else process.env.PATH = originalPath;
         process.argv[1] = originalArgv1;
      }
   }, { timeout: 60000 });

   it('uses only keytar when keychain is configured', async () => {
      writeInstallInfo(pkg.version);
      writeSecretStoreConfig('keychain');
      writeFailingKeytarStub();
      const fakeBinDir = writePassStub();
      const passArgv = path.join(tmpRootDir, 'keychain-mode-pass-argv');
      const originalPath = process.env.PATH;
      const originalPassArgv = process.env.GDX_TEST_PASS_ARGV;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
      process.env.GDX_TEST_PASS_ARGV = passArgv;

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('WARN Secret storage');
         expect(buffer.stdout).toContain(
            'Configured provider: keychain; selected provider: keychain'
         );
         expect(buffer.stdout).toContain('Keytar failed: headless keychain unavailable');
         expect(fs.existsSync(passArgv)).toBe(false);
      } finally {
         if (originalPath === undefined) delete process.env.PATH;
         else process.env.PATH = originalPath;
         if (originalPassArgv === undefined) delete process.env.GDX_TEST_PASS_ARGV;
         else process.env.GDX_TEST_PASS_ARGV = originalPassArgv;
         process.argv[1] = originalArgv1;
         resetConfig();
      }
   }, { timeout: 60000 });

   it('uses only pass when selected through the environment', async () => {
      if (process.platform !== 'linux') return;

      writeInstallInfo(pkg.version);
      const fakeBinDir = writePassStub();
      const passStore = path.join(tmpRootDir, 'explicit-pass-probe-secret');
      const passArgv = path.join(tmpRootDir, 'explicit-pass-probe-argv');
      const originalPath = process.env.PATH;
      const originalProvider = process.env.GDX_SECRET_STORE;
      const originalPassStore = process.env.GDX_TEST_PASS_STORE;
      const originalPassArgv = process.env.GDX_TEST_PASS_ARGV;
      process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
      process.env.GDX_SECRET_STORE = 'pass';
      process.env.GDX_TEST_PASS_STORE = passStore;
      process.env.GDX_TEST_PASS_ARGV = passArgv;
      resetConfig();

      try {
         const exitCode = await doctor();

         expect(exitCode).toBe(0);
         expect(buffer.stdout).toContain('PASS Secret storage');
         expect(buffer.stdout).toContain('Configured provider: pass; selected provider: pass');
         expect(buffer.stdout).not.toContain('Keytar failed');
         expect(fs.existsSync(passStore)).toBe(false);
         expect(fs.readFileSync(passArgv, 'utf8')).not.toContain('gdx-keychain-round-trip');
      } finally {
         if (originalPath === undefined) delete process.env.PATH;
         else process.env.PATH = originalPath;
         if (originalProvider === undefined) delete process.env.GDX_SECRET_STORE;
         else process.env.GDX_SECRET_STORE = originalProvider;
         if (originalPassStore === undefined) delete process.env.GDX_TEST_PASS_STORE;
         else process.env.GDX_TEST_PASS_STORE = originalPassStore;
         if (originalPassArgv === undefined) delete process.env.GDX_TEST_PASS_ARGV;
         else process.env.GDX_TEST_PASS_ARGV = originalPassArgv;
         process.argv[1] = originalArgv1;
         resetConfig();
      }
   }, { timeout: 60000 });
});
