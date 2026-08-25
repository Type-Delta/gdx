/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

// Configuration
const PACKAGE_JSON_PATH = path.join(__dirname, '../package.json');
const PACKAGE_DIR = path.join(__dirname, '..');
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
   ensureBinDir();
   fs.writeFileSync(INSTALL_INFO_PATH, JSON.stringify(info, null, 2));
}

function getNativeBinaryName(platform = process.platform) {
   return platform === 'win32' ? 'gdx.exe' : 'gdx';
}

function getNativeBuildArgs(finalPath) {
   return [
      'build',
      PKG_SRC_PATH,
      `--outfile=${finalPath}`,
      '--compile',
      '--bytecode',
      '--production',
      '--keep-names',
   ];
}

function createInstallInfo(mode, finalPath, useNativeShim) {
   return {
      mode,
      platform: process.platform,
      arch: process.arch,
      version: getPackageVersion(),
      userAgent: process.env.npm_config_user_agent || null,
      useNativeShim,
      ts: (new Date).toLocaleString(),
      binaryPath: finalPath
   };
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

   const prefix = execFileSync(npmExecPath, ['config', 'get', 'prefix'], {
      encoding: 'utf8',
      shell: false,
   }).trim();

   return prefix || null;
}


async function checkUrlExists(url) {
   try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      return res.ok;
   } catch (err) {
      throw new Error(
         `Network error while checking prebuilt availability: ${err.message} (${url})`,
         { cause: err }
      );
   }
}

async function downloadFile(url, tmpPath, destPath) {
   const res = await fetch(url, { method: 'GET', redirect: 'follow' });
   if (!res.ok) {
      throw new Error(`Failed to download: ${res.statusText} (${url})`);
   }

   const fileStream = fs.createWriteStream(tmpPath);
   const stream = require('stream');
   const { promisify } = require('util');
   const pipeline = promisify(stream.pipeline);

   await pipeline(res.body, fileStream);
   if (tmpPath !== destPath) {
      fs.renameSync(tmpPath, destPath);
   }
}

function readSha256FromText(text, assetName) {
   const trimmed = text.trim();
   const match = trimmed.match(/\b([a-fA-F0-9]{64})\b/);
   if (!match) {
      throw new Error(`Invalid SHA256 checksum for ${assetName}.`);
   }
   return match[1].toLowerCase();
}

function sha256File(filePath) {
   return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifySha256(filePath, checksumText, assetName) {
   const expected = readSha256FromText(checksumText, assetName);
   const actual = sha256File(filePath);
   if (actual !== expected) {
      throw new Error(
         `Checksum mismatch for ${assetName}. Expected ${expected}, got ${actual}.`
      );
   }
}

function setExecutable(filePath) {
   if (process.platform !== 'win32') {
      fs.chmodSync(filePath, 0o755);
   }
}

function writeFileExecutable(filePath, content) {
   // Remove any existing entry first. npm links bin entries as symlinks
   // (e.g. <bindir>/gdx -> ../gdx/scripts/launcher.cjs); writing without
   // unlinking would follow that symlink and overwrite its target
   // (launcher.cjs) with shim content instead of replacing the bin entry.
   // fs.rmSync unlinks the symlink itself; force ignores a missing path.
   fs.rmSync(filePath, { force: true });
   fs.writeFileSync(filePath, content, { encoding: 'utf8' });
   setExecutable(filePath);
}

/** Removes a replaceable entrypoint without failing the surrounding install. */
function removeEntrypoint(filePath) {
   try {
      fs.rmSync(filePath, { force: true });
      return true;
   } catch {
      return false;
   }
}

/**
 * Builds runtime shims that prefer the installed path and rediscover moved runtimes on PATH.
 * @param {string} runtimeAbsPath - Runtime executable found during installation.
 * @param {string} launcherAbsPath - Package launcher path.
 * @param {'bun' | 'node'} runtimeName - Runtime command to rediscover on PATH.
 * @returns {{ cmd: string, sh: string }} Windows and POSIX shim contents.
 */
function buildRuntimeShimContents(runtimeAbsPath, launcherAbsPath, runtimeName) {
   return {
      cmd: [
         '@echo off',
         'set "GDX_RUNTIME_SHIM=1"',
         `if not exist "${runtimeAbsPath}" goto gdx_path_runtime`,
         `"${runtimeAbsPath}" "${launcherAbsPath}" -- %*`,
         'exit /b %ERRORLEVEL%',
         ':gdx_path_runtime',
         'set "GDX_RUNTIME_PATH_FALLBACK=1"',
         'setlocal',
         'set "GDX_RUNTIME_PATH="',
         `for /f "delims=" %%G in ('${runtimeName} -e "process.stdout.write(process.execPath)"') do set "GDX_RUNTIME_PATH=%%G"`,
         'if not defined GDX_RUNTIME_PATH exit /b 1',
         `endlocal & "%GDX_RUNTIME_PATH%" "${launcherAbsPath}" -- %*`,
         'exit /b %ERRORLEVEL%',
         ''
      ].join('\r\n'),
      sh: [
         '#!/usr/bin/env sh',
         'export GDX_RUNTIME_SHIM=1',
         `if [ -x "${runtimeAbsPath}" ]; then`,
         `  exec "${runtimeAbsPath}" "${launcherAbsPath}" -- "$@"`,
         'fi',
         'export GDX_RUNTIME_PATH_FALLBACK=1',
         `runtime_path="$(${runtimeName} -e 'process.stdout.write(process.execPath)')" || exit $?`,
         '[ -n "$runtime_path" ] || exit 1',
         `exec "$runtime_path" "${launcherAbsPath}" -- "$@"`,
         ''
      ].join('\n'),
   };
}

function getLocalNodeModulesBinDir() {
   return path.resolve(PACKAGE_DIR, '..', '.bin');
}

function overwriteRuntimeShim(binDir, launcherAbsPath, runtime, platform = process.platform) {
   if (!binDir || !fs.existsSync(binDir)) return false;

   const shims = buildRuntimeShimContents(runtime.executable, launcherAbsPath, runtime.name);

   if (platform === 'win32') {
      if (!removeEntrypoint(path.join(binDir, 'gdx.exe'))) return false;
      fs.rmSync(path.join(binDir, 'gdx.ps1'), { force: true });
      writeFileExecutable(path.join(binDir, 'gdx'), shims.sh);
      writeFileExecutable(path.join(binDir, 'gdx.cmd'), shims.cmd);
      return true;
   }

   writeFileExecutable(path.join(binDir, 'gdx'), shims.sh);
   return true;
}

/**
 * Installs a native entrypoint without a shell boundary.
 * @param binDir - npm bin directory to update.
 * @param nativeAbsPath - Compiled gdx executable.
 * @param platform - Target platform.
 * @returns True when an entrypoint was installed.
 */
function overwriteNativeShim(binDir, nativeAbsPath, platform = process.platform) {
   if (!binDir || !fs.existsSync(binDir)) return false;

   if (platform === 'win32') {
      const executablePath = path.join(binDir, 'gdx.exe');
      if (!removeEntrypoint(executablePath)) return false;
      try {
         fs.linkSync(nativeAbsPath, executablePath);
      } catch {
         fs.copyFileSync(nativeAbsPath, executablePath);
      }
      fs.rmSync(path.join(binDir, 'gdx.cmd'), { force: true });
      fs.rmSync(path.join(binDir, 'gdx.ps1'), { force: true });
      writeFileExecutable(
         path.join(binDir, 'gdx'),
         ['#!/usr/bin/env sh', `exec "${nativeAbsPath}" "$@"`, ''].join('\n')
      );
      return true;
   }

   writeFileExecutable(
      path.join(binDir, 'gdx'),
      ['#!/usr/bin/env sh', `exec "${nativeAbsPath}" "$@"`, ''].join('\n')
   );
   return true;
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
      log('This may result in overhead introduced by the JavaScript launch script.');
      return false;
   }

   const globalBin = getNpmGlobalBinDir();
   if (!globalBin) return false;

   return overwriteNativeShim(globalBin, nativeAbsPath);
}

/**
 * Installs native entrypoints in every npm bin directory available to this install.
 * @param nativeAbsPath - Compiled gdx executable.
 * @returns Per-directory installation results.
 */
function installNativeShims(nativeAbsPath) {
   return {
      local: overwriteNativeShim(getLocalNodeModulesBinDir(), nativeAbsPath),
      global: overwriteGlobalShim(nativeAbsPath),
   };
}

function findRuntimeExecutable(name, platform = process.platform) {
   const locator = platform === 'win32' ? 'where.exe' : 'which';
   const located = spawnSync(locator, [name], {
      encoding: 'utf8',
      windowsHide: true,
   });
   if (located.error || located.status !== 0) return null;

   for (const executable of String(located.stdout || '').split(/\r?\n/).filter(Boolean)) {
      const needsShell = platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
      const probe = needsShell
         ? spawnSync(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', `""${executable}" -e "process.stdout.write(process.execPath)""`],
            { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }
         )
         : spawnSync(executable, ['-e', 'process.stdout.write(process.execPath)'], {
            encoding: 'utf8',
            windowsHide: true,
         });
      const runtimeExecutable = String(probe.stdout || '').trim();
      if (!probe.error && probe.status === 0 && fs.existsSync(runtimeExecutable)) {
         return runtimeExecutable;
      }
   }
   return null;
}

/**
 * Selects the fastest available interpreted runtime without nested shell shims.
 * @param findExecutable - Runtime executable resolver.
 * @returns The selected runtime and executable.
 */
function selectFallbackRuntime(findExecutable = findRuntimeExecutable) {
   const bun = findExecutable('bun');
   if (bun) return { name: 'bun', executable: bun };
   return { name: 'node', executable: findExecutable('node') ?? process.execPath };
}

function installRuntimeFallbackShims(runtime) {
   const launcherAbsPath = path.join(__dirname, 'launcher.cjs');
   const localBin = getLocalNodeModulesBinDir();
   const globalBin = getNpmGlobalBinDir();

   return {
      local: overwriteRuntimeShim(localBin, launcherAbsPath, runtime),
      global: overwriteRuntimeShim(globalBin, launcherAbsPath, runtime),
   };
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
   const checksumUrl = `${url}.sha256`;

   log(`Checking availability of prebuilt binary: ${url}`);
   const exists = await checkUrlExists(url);
   if (!exists) {
      throw new Error(`gdx: prebuilt binary not available for ${platform}/${arch} yet (404). Please reinstall without GDX_USE_PREBUILT=1 (unset GDX_USE_PREBUILT or use GDX_BUILD_NATIVE=1).`);
   }

   log(`Downloading prebuilt binary...`);
   const tmpPath = path.join(NATIVE_DIR, `${assetName}.tmp`);
   const checksumTmpPath = path.join(NATIVE_DIR, `${assetName}.sha256.tmp`);
   const checksumPath = path.join(NATIVE_DIR, `${assetName}.sha256`);
   const finalPath = path.join(NATIVE_DIR, 'gdx' + ext);

   ensureBinDir();
   try {
      await downloadFile(url, tmpPath, tmpPath);
      await downloadFile(checksumUrl, checksumTmpPath, checksumPath);
      verifySha256(tmpPath, fs.readFileSync(checksumPath, 'utf8'), assetName);
      fs.renameSync(tmpPath, finalPath);
      setExecutable(finalPath);
   } finally {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(checksumTmpPath, { force: true });
   }

   log(`Prebuilt binary installed to ${finalPath}`);

   const shimInstall = installNativeShims(finalPath);
   writeInstallInfo({
      mode: 'prebuilt',
      platform,
      arch,
      version,
      userAgent: process.env.npm_config_user_agent || null,
      useNativeShim: shimInstall.local || shimInstall.global,
      useGlobalShim: shimInstall.global,
      useLocalShim: shimInstall.local,
      shimMode: process.platform === 'win32' ? 'native-executable' : 'native-shell',
      shimLimitations: [],
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
   const binaryName = getNativeBinaryName(platform);
   const finalPath = path.join(NATIVE_DIR, binaryName);

   // Build command
   const args = getNativeBuildArgs(finalPath);

   ensureBinDir();
   log(`Running: bun ${args.join(' ')}`);
   const build = spawnSync('bun', args, { stdio: 'inherit', shell: true });

   if (build.status !== 0) {
      throw new Error('Native build failed. Please check output above.');
   }

   log(`Native binary built at ${finalPath}`);

   const shimInstall = installNativeShims(finalPath);
   writeInstallInfo({
      ...createInstallInfo('built', finalPath, shimInstall.local || shimInstall.global),
      useGlobalShim: shimInstall.global,
      useLocalShim: shimInstall.local,
      shimMode: process.platform === 'win32' ? 'native-executable' : 'native-shell',
      shimLimitations: [],
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
         const runtime = selectFallbackRuntime();
         log(`No native install requested (default). Using ${runtime.name} fallback.`);
         const shimInstall = installRuntimeFallbackShims(runtime);
         writeInstallInfo({
            mode: 'runtime',
            runtime: runtime.name,
            runtimePath: runtime.executable,
            platform: process.platform,
            arch: process.arch,
            version: getPackageVersion(),
            userAgent: process.env.npm_config_user_agent || null,
            useGlobalShim: shimInstall.global,
            useLocalShim: shimInstall.local,
            shimMode: process.platform === 'win32' ? 'runtime-cmd' : 'runtime-shell',
            shimLimitations: process.platform === 'win32'
               ? [
                  'powershell-empty-arguments',
                  'powershell-percent-expansion',
                  'powershell-cmd-metacharacters',
               ]
               : [],
            ts: (new Date).toLocaleString(),
            launcherPath: path.join(__dirname, 'launcher.cjs')
         });
      }
   } catch (err) {
      error(err.message);
      process.exit(1);
   }
}

if (require.main === module) {
   main();
}

module.exports = {
   buildRuntimeShimContents,
   createInstallInfo,
   downloadFile,
   getNativeBinaryName,
   getNativeBuildArgs,
   getLocalNodeModulesBinDir,
   findRuntimeExecutable,
   installRuntimeFallbackShims,
   overwriteNativeShim,
   overwriteRuntimeShim,
   readSha256FromText,
   selectFallbackRuntime,
   verifySha256,
};
