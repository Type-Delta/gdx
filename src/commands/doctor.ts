import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import dedent from 'dedent';

import { ncc, arrToString, yuString } from '@lib/Tools';
import { quickPrint } from '../utils/utilities';
import { EXECUTABLE_NAME, VERSION } from '../consts';

export default async function doctor(): Promise<number> {
   // Detect native binary info
   let installInfoPath: string | undefined;
   let hasIssues = false;

   const isNode = process.argv[0].endsWith('node') || process.argv[0].endsWith('node.exe');
   const isBun = process.argv[0].endsWith('bun') || process.argv[0].endsWith('bun.exe');
   const isNative = (process.argv[1].endsWith('gdx') || process.argv[1].endsWith('gdx.exe')) || !isNode && !isBun;

   if (!isNative) {
      const scriptPath = process.argv[1];
      const scriptDir = path.dirname(scriptPath);

      // Check common locations relative to script
      const candidates = [
         path.join(scriptDir, 'native/install.json'),       // dist/index.js -> dist/native/install.json
         path.join(scriptDir, '../dist/native/install.json'), // bin/gdx.cjs -> dist/native/install.json
         path.join(scriptDir, '../native/install.json'),    // if script is in dist/
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
         quickPrint(ncc('Red') + `Error reading install.json: ${e}` + ncc());
         hasIssues = true;
      }
   } else if (isNative) {
      quickPrint(ncc('Yellow') + `No native install info found at ${installInfoPath}` + ncc());
      hasIssues = true;
   }

   quickPrint(`Version: ${ncc('Cyan') + VERSION + ncc()}`);
   quickPrint(`Platform: ${ncc('Magenta') + process.platform + ncc()}`);
   quickPrint(`Arch: ${ncc('Magenta') + process.arch + ncc()}`);
   quickPrint(`Runtime: ${ncc('Magenta') + (isBun ? 'Bun' : 'Node.js') + (isNative ? ' (Native)' : '') + ncc()}`);

   // Detect runtimes
   try {
      const bunVer = await execa('bun', ['--version']);
      quickPrint(`Bun: ${ncc('Cyan') + bunVer.stdout.trim() + ncc()}`);
   } catch {
      quickPrint(`Bun: Not found`);
   }

   try {
      const nodeVer = await execa('node', ['--version']);
      quickPrint(`Node: ${ncc('Cyan') + nodeVer.stdout.trim() + ncc()}`);
   } catch {
      quickPrint(`Node: Not found`);
   }

   // Installation mode (native vs interpreted)
   quickPrint(`Installation mode: ${isNative ? ncc('Green') + 'Native' + ncc() : ncc('Yellow') + 'Interpreted' + ncc()}` + (process.env.NODE_ENV === 'production' ? '' : ncc('Bright') + ' (development)' + ncc()));

   // Detect git
   try {
      const gitVer = await execa('git', ['--version']);
      quickPrint(`Git: ${ncc('Cyan') + gitVer.stdout.trim() + ncc()}`);

      // Check path
      const whichGit = process.platform === 'win32' ? 'where' : 'which';
      const gitPath = await execa(whichGit, ['git']);
      const gitPaths = gitPath.stdout.trim().replaceAll('\n', '\n - ');
      quickPrint(`Git path: ${gitPaths ? ncc('Green') + '\n - ' + gitPaths + ncc() : 'Not found in PATH'}`);
   } catch {
      quickPrint(ncc('Red') + `Git: Not found or error checking` + ncc());
      hasIssues = true;
   }

   // Print argv for debugging
   quickPrint(`Process argv: ` + arrToString(process.argv, { color: true, indent: 2, maxCol: 80 }));

   // Native install info
   if (nativeInsInfo) {
      quickPrint(`\nNative Install Info: ${ncc('Green') + nativeInsInfo + ncc()}`);
   }
   else {
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
   long: dedent(`
      ${ncc('Cyan')}gdx doctor - Diagnose installation and environment${ncc()}

      Checks for native binary, runtimes, and provides installation guidance.
   `),
   short: 'Diagnose installation and environment.',
   usage: `${EXECUTABLE_NAME} doctor`,
};
