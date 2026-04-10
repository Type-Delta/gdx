import fs from 'fs';
import path from 'path';
import { execa } from 'execa';

import { ncc, arrToString, yuString, strWrap, remap, Err, hyperlink, CheckCache } from '@lib/Tools';
import { quickPrint } from '../utils/utilities';
import Logger from '../utils/logger';
import { EXECUTABLE_NAME, GDX_RESULT_FILE, VERSION } from '../consts';
import global from '@/global';
import { GDX_VPALETTE } from '../consts';
import { _2PointGradient } from '../modules/graphics';
import { CommandStructure } from '@/common/types';
import { getCache } from '@/common/cache';
import litedent from '@/utils/litedent';

export default async function doctor(): Promise<number> {
   // Detect native binary info
   let installInfoPath: string | undefined;
   let hasIssues = false;

   const isNode = process.argv[0].endsWith('node') || process.argv[0].endsWith('node.exe');
   const isBun = process.argv[0].endsWith('bun') || process.argv[0].endsWith('bun.exe');
   const isNative = process.execPath.toLowerCase() !== process.argv[0].toLowerCase();

   if (!isNative) {
      const scriptPath = process.argv[1];
      const scriptDir = path.dirname(scriptPath);

      // Check common locations relative to script
      const candidates = [
         path.join(scriptDir, 'native/install.json'), // dist/index.js -> dist/native/install.json
         path.join(scriptDir, '../dist/native/install.json'), // bin/gdx.cjs -> dist/native/install.json
         path.join(scriptDir, '../native/install.json'), // if script is in dist/
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
   if (fs.existsSync(installInfoPath)) {
      try {
         const info = JSON.parse(fs.readFileSync(installInfoPath, 'utf8'));
         nativeInsInfo = yuString(info, { color: true });
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

   quickPrint(`Version: ${ncc('Cyan') + VERSION + ncc()}`);
   quickPrint(`Platform: ${ncc('Magenta') + process.platform} (${process.arch})` + ncc());
   quickPrint(
      `Runtime: ${ncc('Magenta') + (isBun ? 'Bun' : isNode ? 'Node' : 'Unknown') + (isNative ? ' (Native)' : '') + ncc()}`
   );
   quickPrint(`Terminal color support index: ${ncc('Cyan') + (CheckCache.supportsColor) + ncc() + ncc('Dim')} ${CheckCache.supportsColor === 0 ? '(No color)' : CheckCache.supportsColor === 1 ? '(16 colors)' : CheckCache.supportsColor === 2 ? '(8bit color)' : CheckCache.supportsColor === 3 ? '(24bit True color)' : ''}` + ncc());
   quickPrint(`TTY mode: ${ncc('Cyan') + (process.stdout.isTTY ? 'Yes' : 'No') + ncc()}`);

   // Detect runtimes
   try {
      const bunVer = await execa('bun', ['--version']);
      quickPrint(`Bun: ${ncc('Cyan') + bunVer.stdout.trim() + ncc()}` + (!isBun ? ncc('Dim') + ` (inactive)` + ncc() : ''));
   } catch {
      quickPrint(`Bun: Not found`);
   }

   try {
      const nodeVer = await execa('node', ['--version']);
      quickPrint(`Node: ${ncc('Cyan') + nodeVer.stdout.trim() + ncc()}` + (!isNode ? ncc('Dim') + ` (inactive)` + ncc() : ''));
   } catch {
      quickPrint(`Node: Not found`);
   }

   // Installation mode (native vs interpreted)
   quickPrint(
      `Installation mode: ${isNative ? ncc('Green') + 'Native' + ncc() : ncc('Yellow') + 'Interpreted' + ncc()}` +
      (process.env.NODE_ENV === 'production' ? '' : ncc('Bright') + ' (development mode)' + ncc())
   );

   quickPrint(`Shell Integration: ${GDX_RESULT_FILE ? ncc('Green') + 'Yes' + ncc() : ncc('Red') + 'No' + ncc()}`);

   quickPrint(`Executable path: ${ncc('Cyan') + process.execPath + ncc()}`);

   quickPrint(`Log file path: ${ncc('Cyan') + hyperlink(Logger.logFile, Logger.logFile) + ncc()}`);

   const cache = await getCache();
   quickPrint(
      `Cache file path: ${ncc('Cyan') + hyperlink(cache.cachePath, cache.cachePath) + ncc()}`
   );

   // Detect git
   try {
      const gitVer = await execa('git', ['--version']);
      quickPrint(`Git: ${ncc('Cyan') + gitVer.stdout.trim() + ncc()}`);

      // Check path
      const whichGit = process.platform === 'win32' ? 'where' : 'which';
      const gitPath = await execa(whichGit, ['git']);
      const gitPaths = gitPath.stdout.trim().replaceAll('\n', '\n - ');
      quickPrint(
         `Git path: ${gitPaths ? ncc('Green') + '\n - ' + gitPaths + ncc() : 'Not found in PATH'}`
      );
   } catch {
      quickPrint(ncc('Red') + `Git: Not found or error checking` + ncc());
      hasIssues = true;
   }

   // Print argv for debugging
   const gdxEnvs = remap(process.env, (k) => (k.startsWith('GDX_') ? null : undefined));
   quickPrint(`Process argv: ` + arrToString(process.argv, { color: true, indent: 2, maxCol: 80 }));
   quickPrint(`GDX Environment Variables: ` + yuString(gdxEnvs, { color: true }));

   // Native install info
   if (nativeInsInfo) {
      quickPrint(`\nNative Install Info: ${ncc('Green') + nativeInsInfo + ncc()}`);
   } else {
      quickPrint(ncc('Bright') + `\nActionable next steps:` + ncc());

      if (process.platform === 'win32' && process.arch === 'x64') {
         quickPrint(`To use prebuilt binary:`);
         quickPrint(`  GDX_USE_PREBUILT=1 npm i -g gdx`);
      } else {
         quickPrint(`Prebuilt binary not supported for ${process.platform}/${process.arch}.`);
      }

      quickPrint(`To build locally (requires Bun):`);
      quickPrint(`  GDX_BUILD_NATIVE=1 npm i -g gdx`);
   }

   return hasIssues ? 1 : 0;
}

export const help = {
   long: () => {
      const bright = ncc('Bright');
      const reset = ncc();
      return strWrap(
         litedent`
         ${bright + _2PointGradient('DOCTOR', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
         Diagnose installation and environment.

         ${bright + _2PointGradient('DESCRIPTION', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + reset}
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
      const cyan = ncc('Cyan');
      const dim = ncc('Dim');
      const reset = ncc();
      return strWrap(
         litedent`
         ${cyan}${EXECUTABLE_NAME} doctor${reset}

         Examples:
            ${cyan}${EXECUTABLE_NAME} doctor ${reset + dim}# Diagnose installation and environment${reset}`,
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
