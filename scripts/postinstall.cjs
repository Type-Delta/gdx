/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Configuration
const PACKAGE_JSON_PATH = path.join(__dirname, '../package.json');
const BIN_DIR = path.join(__dirname, '../bin');
const NATIVE_DIR = path.join(BIN_DIR, 'native');
const PKG_SRC_PATH = path.join(__dirname, '../dist/index.js');
const INSTALL_INFO_PATH = path.join(NATIVE_DIR, 'install.json');
const PREBUILT_BASE_URL = process.env.GDX_PREBUILT_BASE_URL || 'https://github.com/Type-Delta/gdx/releases/download';

// Ensure native directory exists
function ensureBinDir() {
   if (!fs.existsSync(NATIVE_DIR)) {
      fs.mkdirSync(NATIVE_DIR, { recursive: true });
   }
}

function getPackageVersion() {
   const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
   return pkg.version;
}

function log(message) {
   console.log(`[gdx-install] ${message}`);
}

function error(message) {
   console.error(`[gdx-install] ERROR: ${message}`);
}

function writeInstallInfo(info) {
   fs.writeFileSync(INSTALL_INFO_PATH, JSON.stringify(info, null, 2));
}

function isTruthy(v) {
   return v === '1' || v === 'true' || v === 'yes';
}

function getPrefixFromEnvOrNpm() {
   if (process.env.npm_config_prefix) {
      return process.env.npm_config_prefix;
   }

   // Fallback: ask npm (works on modern npm)
   const npmExecPath = process.env.npm_execpath;
   if (!npmExecPath) return null;

   const prefix = execFileSync(
      process.execPath,
      [npmExecPath, 'config', 'get', 'prefix'],
      { encoding: 'utf8' }
   ).trim();

   return prefix || null;
}


async function checkUrlExists(url) {
   try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      return res.ok;
   } catch (err) {
      throw new Error(`Network error while checking prebuilt availability: ${err.message} (${url})`);
   }
}

async function downloadFile(url, tmpPath, destPath) {
   const res = await fetch(url, { method: 'GET', redirect: 'follow' });
   if (!res.ok) {
      throw new Error(`Failed to download: ${res.statusText} (${url})`);
   }

   const fileStream = fs.createWriteStream(destPath);
   const stream = require('stream');
   const { promisify } = require('util');
   const pipeline = promisify(stream.pipeline);

   await pipeline(res.body, fileStream);
   fs.renameSync(tmpPath, destPath);
}

function setExecutable(filePath) {
   if (process.platform !== 'win32') {
      fs.chmodSync(filePath, 0o755);
   }
}

function writeFileExecutable(filePath, content) {
   fs.writeFileSync(filePath, content, { encoding: 'utf8' });
   setExecutable(filePath);
}

function getNpmGlobalBinDir() {
   if (!isTruthy(process.env.npm_config_global)) return null;

   const prefix = getPrefixFromEnvOrNpm();
   if (!prefix) return null;

   if (process.platform === 'win32') {
      // On Windows, shims are in the prefix dir itself
      return prefix;
   }

   // On Unix, shims are in <prefix>/bin
   return path.join(prefix, 'bin');
}


function overwriteGlobalShim(nativeAbsPath) {
   if (!isTruthy(process.env.npm_config_global))
      return false;

   if (!(process.env.npm_config_user_agent || '').includes('npm/')) {
      log('Non-npm global install detected; skipping global shim overwrite.');
      log('This may result in overhead introduced by the Node.js launch script.');
      return false;
   }

   const globalBin = getNpmGlobalBinDir();
   if (!globalBin) return false;

   if (process.platform === 'win32') {
      const cmdPath = path.join(globalBin, 'gdx.cmd');
      const ps1Path = path.join(globalBin, 'gdx.ps1');

      const cmd = [
         '@echo off',
         `"${nativeAbsPath}" %*`,
         'exit /b %ERRORLEVEL%',
         ''
      ].join('\r\n');

      const ps1 = [
         `& "${nativeAbsPath}" @args`,
         'exit $LASTEXITCODE',
         ''
      ].join('\r\n');

      writeFileExecutable(cmdPath, cmd);
      writeFileExecutable(ps1Path, ps1);
   } else {
      const shPath = path.join(globalBin, 'gdx');

      const sh = [
         '#!/usr/bin/env sh',
         `exec "${nativeAbsPath}" "$@"`,
         ''
      ].join('\n');

      writeFileExecutable(shPath, sh);
   }
   return true;
}

async function tryDownloadPrebuilt() {
   const version = getPackageVersion();
   const platform = process.platform;
   const arch = process.arch;

   // Currently only supporting win32-x64
   if (platform !== 'win32' || arch !== 'x64') {
      throw new Error(`gdx: prebuilt binary not available for ${platform}/${arch} yet. Please reinstall without GDX_USE_PREBUILT=1 (unset GDX_USE_PREBUILT or use GDX_BUILD_NATIVE=1).`);
   }

   const ext = platform === 'win32' ? '.exe' : '';
   const assetName = `gdx-${platform}-${arch}${ext}`;
   const url = `${PREBUILT_BASE_URL}/v${version}/${assetName}`;

   log(`Checking availability of prebuilt binary: ${url}`);
   const exists = await checkUrlExists(url);
   if (!exists) {
      throw new Error(`gdx: prebuilt binary not available for ${platform}/${arch} yet (404). Please reinstall without GDX_USE_PREBUILT=1 (unset GDX_USE_PREBUILT or use GDX_BUILD_NATIVE=1).`);
   }

   log(`Downloading prebuilt binary...`);
   const tmpPath = path.join(NATIVE_DIR, `${assetName}.tmp`);
   const finalPath = path.join(NATIVE_DIR, 'gdx' + ext);

   ensureBinDir();
   await downloadFile(url, tmpPath, finalPath);
   setExecutable(finalPath);

   log(`Prebuilt binary installed to ${finalPath}`);

   writeInstallInfo({
      mode: 'prebuilt',
      platform,
      arch,
      version,
      userAgent: process.env.npm_config_user_agent || null,
      useNativeShim: overwriteGlobalShim(finalPath),
      ts: (new Date).toLocaleString(),
      binaryPath: finalPath
   });
}

function tryBuildNative() {
   log('Attempting local native build with Bun...');

   // Check for bun
   const bunCheck = spawnSync('bun', ['--version'], { encoding: 'utf8', shell: true });
   if (bunCheck.error || bunCheck.status !== 0) {
      throw new Error('Bun is not installed or not found in PATH. Cannot build native binary. Please install Bun or reinstall without GDX_BUILD_NATIVE=1. (unset GDX_BUILD_NATIVE or set GDX_USE_PREBUILT to use prebuilt binary if available)');
   }

   const platform = process.platform;
   const arch = process.arch;
   const isWin = platform === 'win32';
   const binaryName = isWin ? 'gdx.exe' : 'gdx';
   const finalPath = path.join(NATIVE_DIR, binaryName);

   // Build command
   const args = [
      'build',
      PKG_SRC_PATH,
      `--outfile=${finalPath}`,
      '--compile',
      '--bytecode',
      '--production',
      '--keep-names'
   ];

   ensureBinDir();
   log(`Running: bun ${args.join(' ')}`);
   const build = spawnSync('bun', args, { stdio: 'inherit', shell: true });

   if (build.status !== 0) {
      throw new Error('Native build failed. Please check output above.');
   }

   log(`Native binary built at ${finalPath}`);

   writeInstallInfo({
      mode: 'built',
      platform,
      arch,
      version: getPackageVersion(),
      userAgent: process.env.npm_config_user_agent || null,
      useNativeShim: overwriteGlobalShim(finalPath),
      ts: (new Date).toLocaleString(),
      binaryPath: finalPath
   });
}

async function main() {
   const ignoreScripts = isTruthy(process.env.npm_config_ignore_scripts) ||
      isTruthy(process.env.NPM_CONFIG_IGNORE_SCRIPTS);
   if (ignoreScripts) {
      log('Scripts ignored by configuration. Skipping native setup.');
      return;
   }

   try {
      if (isTruthy(process.env.GDX_USE_PREBUILT)) {
         await tryDownloadPrebuilt();
      } else if (isTruthy(process.env.GDX_BUILD_NATIVE)) {
         tryBuildNative();
      } else {
         log('No native install requested (default). Using Node.js fallback.');
         // Do nothing
      }
   } catch (err) {
      error(err.message);
      process.exit(1);
   }
}

main();
