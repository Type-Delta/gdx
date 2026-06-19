import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 20_000;
const TRANSITIVE_EXTERNAL_DEPENDENCIES = ['shiki'] as const;

export interface PostInstallDiagnosticOptions {
   packageRoot: string;
   installInfo: Record<string, unknown> | null;
   isNative: boolean;
}

export interface PostInstallDiagnosticResult {
   name: string;
   status: 'pass' | 'warn' | 'fail';
   detail: string;
}

interface ProbeOutput {
   ok: boolean;
   detail: string;
}

/**
 * Runs the post-install checks kept out of the main gdx bundle.
 * @param options - Runtime and package paths discovered by the doctor command.
 * @returns Results suitable for rendering by the main command.
 */
export async function runPostInstallDiagnostics(
   options: PostInstallDiagnosticOptions
): Promise<PostInstallDiagnosticResult[]> {
   const results = [
      checkRequiredArtifacts(options),
      checkInstallMetadata(options),
      checkShim(options),
   ];

   if (options.isNative) {
      results.push({
         name: 'External dependencies',
         status: 'pass',
         detail: 'Bundled into the native executable; Node package probes are not required.',
      });
      return results;
   }

   let dependencies: string[];
   try {
      dependencies = readPackageDependencies(options.packageRoot);
   } catch (error) {
      results.push({
         name: 'External dependencies',
         status: 'fail',
         detail: error instanceof Error ? error.message : String(error),
      });
      return results;
   }

   const dependencyResults = await Promise.all(
      dependencies.map((dependency) => probeDependency(options.packageRoot, dependency))
   );
   results.push(...dependencyResults);
   return results;
}

/**
 * Reads the runtime dependency names from the installed package manifest.
 * @param packageRoot - Installed gdx package directory.
 * @returns Runtime packages that the Node bundle leaves external.
 */
function readPackageDependencies(packageRoot: string): string[] {
   const manifestPath = path.join(packageRoot, 'package.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
   };
   return [
      ...new Set([
         ...Object.keys(manifest.dependencies ?? {}),
         ...TRANSITIVE_EXTERNAL_DEPENDENCIES,
      ]),
   ];
}

/**
 * Checks files that must survive npm packing for interpreted installs.
 * @param options - Current installation details.
 * @returns A single aggregate artifact result.
 */
function checkRequiredArtifacts(
   options: PostInstallDiagnosticOptions
): PostInstallDiagnosticResult {
   const commonArtifacts = ['package.json', 'scripts/launcher.cjs', 'scripts/postinstall.cjs'];
   const requiredArtifacts = options.isNative
      ? commonArtifacts
      : [...commonArtifacts, 'dist/index.js', 'dist/workers/generic.worker.min.js'];
   const missing = requiredArtifacts.filter(
      (relativePath) => !fs.existsSync(path.join(options.packageRoot, relativePath))
   );
   const diagnosticArtifacts = [
      'dist/diagnostics/post-install.validator.js',
      'bin/diagnostics/post-install.validator.js',
   ];
   if (
      !diagnosticArtifacts.some((relativePath) =>
         fs.existsSync(path.join(options.packageRoot, relativePath))
      )
   ) {
      missing.push(diagnosticArtifacts.join(' or '));
   }

   return missing.length === 0
      ? {
           name: 'Required artifacts',
           status: 'pass',
           detail: `${requiredArtifacts.length + 1} packaged artifacts are present.`,
        }
      : {
           name: 'Required artifacts',
           status: 'fail',
           detail: `Missing: ${missing.join(', ')}`,
        };
}

/**
 * Validates postinstall metadata against the package and current machine.
 * @param options - Current installation details.
 * @returns The metadata consistency result.
 */
function checkInstallMetadata(options: PostInstallDiagnosticOptions): PostInstallDiagnosticResult {
   if (!options.installInfo) {
      return {
         name: 'Install metadata',
         status: 'fail',
         detail: 'Postinstall did not produce bin/native/install.json.',
      };
   }

   try {
      const manifest = JSON.parse(
         fs.readFileSync(path.join(options.packageRoot, 'package.json'), 'utf8')
      ) as { version?: string };
      const mismatches: string[] = [];
      if (options.installInfo.version !== manifest.version) {
         mismatches.push(
            `version ${String(options.installInfo.version)} (expected ${manifest.version})`
         );
      }
      if (options.installInfo.platform !== process.platform) {
         mismatches.push(
            `platform ${String(options.installInfo.platform)} (expected ${process.platform})`
         );
      }
      if (options.installInfo.arch !== process.arch) {
         mismatches.push(
            `architecture ${String(options.installInfo.arch)} (expected ${process.arch})`
         );
      }
      return mismatches.length === 0
         ? {
              name: 'Install metadata',
              status: 'pass',
              detail: 'Version, platform, and architecture match this installation.',
           }
         : {
              name: 'Install metadata',
              status: 'fail',
              detail: `Mismatched ${mismatches.join('; ')}.`,
           };
   } catch (error) {
      return {
         name: 'Install metadata',
         status: 'fail',
         detail: error instanceof Error ? error.message : String(error),
      };
   }
}

/**
 * Checks whether postinstall recorded and activated the expected npm shim.
 * @param options - Current installation details.
 * @returns The shim diagnostic result.
 */
function checkShim(options: PostInstallDiagnosticOptions): PostInstallDiagnosticResult {
   const info = options.installInfo;
   if (!info) {
      return {
         name: 'Command shim',
         status: 'fail',
         detail: 'bin/native/install.json is missing or unreadable.',
      };
   }

   if (options.isNative) {
      if (info.mode === 'node') {
         return {
            name: 'Command shim',
            status: 'fail',
            detail:
               'Install metadata selects Node fallback, but a stale native binary was launched.',
         };
      }
      const binaryPath = typeof info.binaryPath === 'string' ? info.binaryPath : process.execPath;
      const expectedNativeShim = info.useNativeShim === true;
      return {
         name: 'Command shim',
         status: expectedNativeShim ? 'pass' : 'warn',
         detail: expectedNativeShim
            ? `The npm shim targets the native binary (${binaryPath}).`
            : 'The native binary is running, but postinstall did not confirm a native shim.',
      };
   }

   const shimInstalled = info.useGlobalShim === true || info.useLocalShim === true;
   const shimActive = process.env.GDX_NODE_SHIM === '1';
   if (!shimInstalled) {
      return {
         name: 'Command shim',
         status: 'warn',
         detail:
            'Postinstall did not record a rewritten Node shim (common with non-npm installers).',
      };
   }

   return {
      name: 'Command shim',
      status: shimActive ? 'pass' : 'fail',
      detail: shimActive
         ? 'The postinstall Node shim is installed and active for this invocation.'
         : 'A rewritten Node shim was recorded, but this invocation bypassed it.',
   };
}

/**
 * Imports and exercises one external dependency in a clean Node subprocess.
 * @param packageRoot - Installed gdx package directory.
 * @param dependency - Package name to probe.
 * @returns A dependency-specific result.
 */
async function probeDependency(
   packageRoot: string,
   dependency: string
): Promise<PostInstallDiagnosticResult> {
   try {
      const { stdout } = await execFileAsync(
         process.execPath,
         ['--input-type=module', '--eval', createProbeScript(), packageRoot, dependency],
         {
            cwd: packageRoot,
            timeout: PROBE_TIMEOUT_MS,
            windowsHide: true,
            env: { ...process.env, GDX_DOCTOR_PROBE: '1' },
         }
      );
      const output = JSON.parse(stdout.trim()) as ProbeOutput;
      const isKeychainWarning = dependency === 'keytar' && !output.ok;
      return {
         name: `Dependency: ${dependency}`,
         status: output.ok ? 'pass' : isKeychainWarning ? 'warn' : 'fail',
         detail: output.detail,
      };
   } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
         name: `Dependency: ${dependency}`,
         status: dependency === 'keytar' ? 'warn' : 'fail',
         detail: `Probe failed: ${detail}`,
      };
   }
}

/**
 * Creates the isolated ESM probe executed by the installed Node runtime.
 * @returns JavaScript source with package-specific smoke tests.
 */
function createProbeScript(): string {
   return String.raw`
const packageRoot = process.argv[1];
const dependency = process.argv[2];

try {
   process.chdir(packageRoot);
   const imported = await import(dependency);
   const module = imported.default && Object.keys(imported).length === 1 ? imported.default : imported;

   if (dependency === 'keytar') {
      const keytar = imported.default ?? imported;
      const service = 'gdx-doctor-probe';
      const account = 'probe-' + process.pid + '-' + Date.now();
      const secret = 'gdx-keychain-round-trip';
      try {
         await keytar.setPassword(service, account, secret);
         const value = await keytar.getPassword(service, account);
         if (value !== secret) throw new Error('Keychain returned an unexpected value.');
      } finally {
         await keytar.deletePassword(service, account).catch(() => false);
      }
   } else if (dependency === 'yaml') {
      if (imported.parse('healthy: true').healthy !== true) throw new Error('YAML parse failed.');
   } else if (dependency === 'fflate') {
      const input = imported.strToU8('gdx');
      if (imported.strFromU8(imported.gunzipSync(imported.gzipSync(input))) !== 'gdx') throw new Error('Compression round-trip failed.');
   } else if (dependency === 'diff') {
      if (!imported.diffChars('gdx', 'GDX').some((part) => part.added)) throw new Error('Diff smoke test failed.');
   } else if (dependency === '@leeoniya/ufuzzy') {
      const U = imported.default;
      const fuzzy = new U();
      if (!Array.isArray(fuzzy.filter(['gdx'], 'gdx'))) throw new Error('Fuzzy-search smoke test failed.');
   } else if (dependency === 'openai') {
      const OpenAI = imported.default ?? imported.OpenAI;
      if (!new OpenAI({ apiKey: 'doctor-probe-key' }).chat) throw new Error('OpenAI client construction failed.');
   } else if (dependency === 'cspell-lib') {
      if (typeof imported.getDefaultSettings !== 'function') throw new Error('cspell settings API is unavailable.');
      imported.getDefaultSettings();
   } else if (dependency === '@shikijs/cli') {
      if (typeof imported.codeToANSI !== 'function') throw new Error('Shiki ANSI API is unavailable.');
      await imported.codeToANSI('const gdx = true', 'typescript', 'github-dark');
   } else if (dependency === 'shiki') {
      if (typeof imported.codeToHtml !== 'function') throw new Error('Shiki HTML API is unavailable.');
      const html = await imported.codeToHtml('const gdx = true', { lang: 'typescript', theme: 'github-dark' });
      if (!html.includes('<pre')) throw new Error('Syntax highlighting smoke test failed.');
   } else if (!module) {
      throw new Error('Imported module was empty.');
   }

   process.stdout.write(JSON.stringify({ ok: true, detail: 'Resolved, imported, and passed its smoke test.' }));
} catch (error) {
   process.stdout.write(JSON.stringify({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
}
`;
}
