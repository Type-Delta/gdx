import litedent from 'litedent';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';

import { arrToString, yuString, strWrap, remap, Err, hyperlink, CheckCache } from '@lib/Tools';

import { quickPrint } from '../utils/utilities';
import Logger from '../utils/logger';
import { EXECUTABLE_NAME, GDX_RESULT_FILE, VERSION, BUILD, IS_CUSTOM_BUILD, SGR } from '../consts';
import global from '@/global';
import { GDX_VPALETTE } from '../consts';
import { _2PointGradient } from '../modules/graphics';
import { CommandStructure } from '@/common/types';
import { getCache } from '@/common/cache';
import { getConfig } from '@/common/config';
import { GDX_HISTORY_GUARD_ENV } from '@/modules/shell';

type SecretStoreProvider = 'auto' | 'keychain' | 'pass';

interface PostInstallDiagnosticResult {
   name: string;
   status: 'pass' | 'warn' | 'fail';
   detail: string;
}

interface PostInstallDiagnosticsModule {
   runPostInstallDiagnostics: (options: {
      packageRoot: string;
      installInfo: Record<string, unknown> | null;
      isNative: boolean;
      shimActive: boolean;
      shimPathFallback: boolean;
      secretStoreProvider: SecretStoreProvider;
   }) => Promise<PostInstallDiagnosticResult[]>;
}

export default async function doctor(): Promise<number> {
   // Detect native binary info
   let installInfoPath: string | undefined;
   let hasIssues = false;

   const isBun = Boolean(process.versions.bun);
   const isNative = isBun && !/[\\/]bun(?:\.exe)?$/i.test(process.execPath);

   if (!isNative) {
      const scriptPath = process.argv[1];
      const scriptDir = path.dirname(scriptPath);

      // Check common locations relative to script
      const candidates = [
         path.join(scriptDir, 'native/install.json'), // dist/index.js -> dist/native/install.json
         path.join(scriptDir, '../dist/native/install.json'), // bin/gdx.cjs -> dist/native/install.json
         path.join(scriptDir, '../native/install.json'), // if script is in dist/
         path.join(scriptDir, '../bin/native/install.json'), // src/, dist/, or scripts/ -> bin/native/
      ];

      for (const p of candidates) {
         if (fs.existsSync(p)) {
            installInfoPath = p;
            break;
         }
      }

      // Default if not found (for error message)
      if (!installInfoPath) {
         installInfoPath = path.join(scriptDir, 'native/install.json');
      }
   } else {
      // Native binary
      installInfoPath = path.join(path.dirname(process.execPath), 'install.json');
   }

   let nativeInsInfo: string | null = null;
   let installInfo: Record<string, unknown> | null = null;
   if (fs.existsSync(installInfoPath)) {
      try {
         installInfo = JSON.parse(fs.readFileSync(installInfoPath, 'utf8')) as Record<
            string,
            unknown
         >;
         nativeInsInfo = yuString(installInfo, { color: true });
      } catch (e) {
         const err = Err.from(e);
         Logger.error(`Error reading install.json: ${err.message}`, 'doctor');
         Logger.debug(err.toString(), 'doctor');
         hasIssues = true;
      }
   } else if (isNative) {
      Logger.warn(`No native install info found at ${installInfoPath}`, 'doctor');
      hasIssues = true;
   }

   const configuredRuntime =
      global.runtimeShimActive && typeof installInfo?.runtime === 'string'
         ? installInfo.runtime
         : null;
   const isNub = !isNative && configuredRuntime === 'nub';
   const isNode = !isNative && !isBun && !isNub;
   const runtimeName = isNative || isBun ? 'Bun' : isNub ? 'Nub' : isNode ? 'Node' : 'Unknown';

   quickPrint(
      `Version: ${SGR.cyan + VERSION + SGR.reset}${IS_CUSTOM_BUILD && BUILD !== 'dev' ? SGR.dim + ` (${BUILD})` + SGR.reset : ''}`
   );
   quickPrint(`Platform: ${SGR.magenta + process.platform} (${process.arch})` + SGR.reset);
   quickPrint(
      `Processor: ${SGR.cyan + (os.cpus()[0]?.model || 'N/A') + SGR.reset} ${os.availableParallelism()}/${os.cpus().length} logical cores`
   );
   quickPrint(
      `Runtime: ${SGR.magenta + runtimeName + (isNative ? ' (Native)' : '') + SGR.reset}`
   );
   quickPrint(
      `Terminal color support index: ${SGR.cyan + CheckCache.supportsColor + SGR.reset + SGR.dim} ${CheckCache.supportsColor === 0 ? '(No color)' : CheckCache.supportsColor === 1 ? '(16 colors)' : CheckCache.supportsColor === 2 ? '(8bit color)' : CheckCache.supportsColor === 3 ? '(24bit True color)' : ''}` +
      SGR.reset
   );
   quickPrint(`TTY mode: ${SGR.cyan + (process.stdout.isTTY ? 'Yes' : 'No') + SGR.reset}`);

   // Detect runtimes
   try {
      const nubVer = await execa('nub', ['--version']);
      quickPrint(
         `Nub: ${SGR.cyan + nubVer.stdout.trim().split(/\r?\n/)[0] + SGR.reset}` +
         (!isNub ? SGR.dim + ` (inactive)` + SGR.reset : '')
      );
   } catch {
      quickPrint(`Nub: Not found`);
   }

   try {
      const bunVer = await execa('bun', ['--version']);
      quickPrint(
         `Bun: ${SGR.cyan + bunVer.stdout.trim() + SGR.reset}` +
         (!isBun ? SGR.dim + ` (inactive)` + SGR.reset : '')
      );
   } catch {
      quickPrint(`Bun: Not found`);
   }

   try {
      const nodeVer = await execa('node', ['--version']);
      quickPrint(
         `Node: ${SGR.cyan + nodeVer.stdout.trim() + SGR.reset}` +
         (!isNode ? SGR.dim + ` (inactive)` + SGR.reset : '')
      );
   } catch {
      quickPrint(`Node: Not found`);
   }

   // Installation mode (native vs interpreted)
   quickPrint(
      `Installation mode: ${isNative ? SGR.green + 'Native' + SGR.reset : SGR.yellow + 'Interpreted' + SGR.reset}` +
      (process.env.NODE_ENV === 'production'
         ? ''
         : SGR.bright + ' (development mode)' + SGR.reset)
   );

   quickPrint(
      `Shell Integration: ${GDX_RESULT_FILE ? SGR.green + 'Yes' + SGR.reset : SGR.red + 'No' + SGR.reset}`
   );

   quickPrint(`Executable path: ${SGR.cyan + process.execPath + SGR.reset}`);

   quickPrint(`Log file path: ${SGR.cyan + hyperlink(Logger.logFile, Logger.logFile) + SGR.reset}`);

   const cache = await getCache();
   quickPrint(
      `Cache file path: ${SGR.cyan + hyperlink(cache.cachePath, cache.cachePath) + SGR.reset}`
   );

   // Detect git
   try {
      const gitVer = await execa('git', ['--version'], { env: GDX_HISTORY_GUARD_ENV });
      quickPrint(`Git: ${SGR.cyan + gitVer.stdout.trim() + SGR.reset}`);

      // Check path
      const whichGit = process.platform === 'win32' ? 'where' : 'which';
      const gitPath = await execa(whichGit, ['git']);
      const gitPaths = gitPath.stdout.trim().replaceAll('\n', '\n - ');
      quickPrint(
         `Git path: ${gitPaths ? SGR.green + '\n - ' + gitPaths + SGR.reset : 'Not found in PATH'}`
      );
   } catch {
      quickPrint(SGR.red + `Git: Not found or error checking` + SGR.reset);
      hasIssues = true;
   }

   // Print argv for debugging
   const gdxEnvs = remap(process.env, (k) => (k.startsWith('GDX_') ? null : undefined));
   quickPrint(`Process argv: ` + arrToString(process.argv, { color: true, indent: 2, maxCol: 80 }));
   quickPrint(`GDX Environment Variables: ` + yuString(gdxEnvs, { color: true }));

   // Installation info
   if (nativeInsInfo) {
      quickPrint(`\nInstallation Info: ${SGR.green + nativeInsInfo + SGR.reset}`);
   } else {
      quickPrint(SGR.bright + `\nActionable next steps:` + SGR.reset);

      if (process.platform === 'win32' && process.arch === 'x64') {
         quickPrint(`To use prebuilt binary:`);
         quickPrint(`  GDX_USE_PREBUILT=1 npm i -g gdx`);
      } else {
         quickPrint(`Prebuilt binary not supported for ${process.platform}/${process.arch}.`);
      }

      quickPrint(`To build locally (requires Bun):`);
      quickPrint(`  GDX_BUILD_NATIVE=1 npm i -g gdx`);
   }

   const packageRoot = findPackageRoot(installInfoPath);
   const config = await getConfig();
   const secretStoreProvider = config.get<SecretStoreProvider>('security.secretStore', 'auto');
   const diagnostics = await runPostInstallDiagnostics(
      packageRoot,
      installInfo,
      isNative,
      secretStoreProvider
   );
   quickPrint(SGR.bright + `\nPost-install integration checks:` + SGR.reset);
   for (const result of diagnostics) {
      const marker = result.status === 'pass' ? 'PASS' : result.status === 'warn' ? 'WARN' : 'FAIL';
      const color =
         result.status === 'pass' ? SGR.green : result.status === 'warn' ? SGR.yellow : SGR.red;
      quickPrint(` ${color + marker + SGR.reset} ${result.name}: ${result.detail}`);
      if (result.status === 'fail') hasIssues = true;
   }

   return hasIssues ? 1 : 0;
}

/**
 * Loads and runs the separately built post-install integration checks.
 * @param packageRoot - Root directory of the current gdx installation.
 * @param installInfo - Parsed postinstall metadata, when available.
 * @param isNative - Whether gdx is running as a compiled executable.
 * @param secretStoreProvider - Configured secret storage provider.
 * @returns Diagnostic results, including a failure when the sidecar cannot load.
 */
async function runPostInstallDiagnostics(
   packageRoot: string,
   installInfo: Record<string, unknown> | null,
   isNative: boolean,
   secretStoreProvider: SecretStoreProvider
): Promise<PostInstallDiagnosticResult[]> {
   const candidates = [
      path.join(packageRoot, 'dist/diagnostics/postinstall.validator.js'),
      path.join(path.dirname(process.execPath), 'diagnostics/postinstall.validator.js'),
      path.join(path.dirname(process.execPath), '../../dist/diagnostics/postinstall.validator.js'),
      path.join(
         path.dirname(fileURLToPath(import.meta.url)),
         '../../test/postinstall.validator.ts'
      ),
   ];
   const artifactPath = candidates.find((candidate) => fs.existsSync(candidate));
   if (!artifactPath) {
      return [
         {
            name: 'Diagnostic artifact',
            status: 'fail',
            detail: `Not found (checked ${candidates.join(', ')}).`,
         },
      ];
   }

   try {
      const artifactUrl = pathToFileURL(artifactPath).href;
      const module = (await import(artifactUrl)) as PostInstallDiagnosticsModule;
      return await module.runPostInstallDiagnostics({
         packageRoot,
         installInfo,
         isNative,
         shimActive: global.runtimeShimActive,
         shimPathFallback: global.runtimeShimPathFallback,
         secretStoreProvider,
      });
   } catch (e) {
      const err = Err.from(e);
      return [
         {
            name: 'Diagnostic artifact',
            status: 'fail',
            detail: `Failed to load ${artifactPath}: ${err.message}`,
         },
      ];
   }
}

/**
 * Finds the package root without relying on the caller's current directory.
 * @param installInfoPath - Expected or discovered postinstall metadata path.
 * @returns The nearest ancestor containing package.json, or the install layout root.
 */
function findPackageRoot(installInfoPath: string): string {
   let current = path.dirname(installInfoPath);
   for (let depth = 0; depth < 5; depth++) {
      if (fs.existsSync(path.join(current, 'package.json'))) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
   }
   return path.resolve(path.dirname(installInfoPath), '../..');
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('DOCTOR', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Diagnose installation and environment.

         ${SGR.bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Checks for native binary, runtimes, and provides installation guidance.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Run a diagnostic check on gdx installation and environment.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} doctor${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} doctor ${SGR.reset + SGR.dim}# Diagnose installation and environment${SGR.reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const;

export const structure = {
   $root: [],
} as const satisfies CommandStructure;
