import path from 'path';

import { yuString } from '@lib/Tools';

import * as fs from '@/modules/fs';
import { $, spinner, whichExec } from '@/modules/shell';
import Logger from '@/utils/logger';
import { getConfig } from '@/common/config';
import { initSubmodules } from '@/modules/git';
import { buildGitignoreMatcher, buildPathGlobMatcher } from '@/utils/glob';

export type WorktreeInitBehavior = 'submodule' | 'pkg' | 'env';

export interface WorktreeInitOptions {
   git$: string | string[];
   worktreePath: string;
   originPath?: string;
   noInitAll?: boolean;
   noInitList?: string | null;
}

const INIT_BEHAVIOR_SET = new Set<WorktreeInitBehavior>(['submodule', 'pkg', 'env']);

interface ParsedBehaviorList {
   values: WorktreeInitBehavior[];
   invalid: string[];
}

interface PackageInitResult {
   ran: boolean;
   warnings: string[];
}

type PackageManager = 'npm' | 'pnpm' | 'bun';

export async function runWorktreeInit(options: WorktreeInitOptions): Promise<void> {
   const warnings: string[] = [];
   let shouldSkip = false;

   try {
      const config = await getConfig();

      const configValue = config.get('parallel.init', 'submodule,env');
      const parsedConfig = parseBehaviorList(configValue);
      if (parsedConfig.invalid.length > 0) {
         warnings.push(
            `Unknown parallel.init values: ${parsedConfig.invalid.join(', ')}. ` +
               'Valid values: submodule, env, pkg.'
         );
      }

      const parsedNoInit = parseBehaviorList(options.noInitList);
      if (parsedNoInit.invalid.length > 0) {
         warnings.push(
            `Unknown --no-init values: ${parsedNoInit.invalid.join(', ')}. ` +
               'Valid values: submodule, env, pkg.'
         );
      }

      if (options.noInitAll || options.noInitList === '') {
         shouldSkip = true;
      }

      const disabled = new Set(parsedNoInit.values);
      const behaviors = parsedConfig.values.filter((behavior) => !disabled.has(behavior));
      if (behaviors.length === 0) {
         shouldSkip = true;
      }

      if (!shouldSkip && behaviors.includes('submodule')) {
         const spinnerCtrl = spinner({
            message: 'Initializing git submodules...',
         });
         try {
            await initSubmodules(options.git$, options.worktreePath);
            spinnerCtrl.stop();
         } catch (err) {
            spinnerCtrl.stop();
            warnings.push(`Submodule init failed. ${yuString(err, { color: true })}`);
         }
      }

      if (!shouldSkip && behaviors.includes('env')) {
         const result = await initEnvFiles(options.worktreePath, options.originPath, warnings);
         warnings.push(...result.warnings);
      }

      if (!shouldSkip && behaviors.includes('pkg')) {
         const result = await initPackages(options.worktreePath);
         warnings.push(...result.warnings);
      }
   } catch (err) {
      warnings.push(`Init failed. ${yuString(err, { color: true })}`);
   }

   flushWarnings(warnings);
}

interface EnvInitResult {
   copied: number;
   warnings: string[];
}

interface EnvPatternSet {
   rootFiles: string[];
   envPaths: string[];
}

function flushWarnings(warnings: string[]): void {
   for (const warning of warnings) {
      Logger.warn(warning, 'worktree-init');
   }
}

function parseBehaviorList(raw: unknown): ParsedBehaviorList {
   const values: WorktreeInitBehavior[] = [];
   const invalid: string[] = [];
   const seen = new Set<WorktreeInitBehavior>();

   let entries: string[] = [];

   if (Array.isArray(raw)) {
      entries = raw.map((entry) => String(entry));
   } else if (typeof raw === 'string') {
      entries = raw.split(',');
   } else if (raw != null) {
      entries = [String(raw)];
   }

   for (const entry of entries) {
      const normalized = entry.trim().toLowerCase();
      if (!normalized) continue;
      if (INIT_BEHAVIOR_SET.has(normalized as WorktreeInitBehavior)) {
         const behavior = normalized as WorktreeInitBehavior;
         if (!seen.has(behavior)) {
            values.push(behavior);
            seen.add(behavior);
         }
      } else {
         invalid.push(normalized);
      }
   }

   return { values, invalid };
}

async function initPackages(worktreePath: string): Promise<PackageInitResult> {
   const warnings: string[] = [];
   let ran = false;

   const jsManager = detectJsPackageManager(worktreePath, warnings);
   if (jsManager) {
      const didRun = await runPackageInstall(jsManager, worktreePath, warnings);
      ran ||= didRun;
   }

   if (detectUvProject(worktreePath)) {
      const didRun = await runUvSync(worktreePath, warnings);
      ran ||= didRun;
   }

   return { ran, warnings };
}

/**
 * Copies ignored env-like files from the origin worktree into the fork.
 * Root file patterns come from the origin .gitignore and envPaths are glob-like paths.
 */
async function initEnvFiles(
   worktreePath: string,
   originPath: string | undefined,
   warnings: string[]
): Promise<EnvInitResult> {
   const envWarnings: string[] = [];
   let copied = 0;
   try {
      const config = await getConfig();
      const sourcePath = originPath || worktreePath;
      const { rootFiles, envPaths } = await collectEnvPatterns(sourcePath, config, envWarnings);
      if (rootFiles.length === 0 && envPaths.length === 0) {
         return { copied: 0, warnings: envWarnings };
      }

      if (rootFiles.length > 0) {
         const includeMatchers = rootFiles.map((pattern) => buildGitignoreMatcher(pattern));
         const rootEntries = await listRootFiles(sourcePath, envWarnings);

         for (const fileName of rootEntries) {
            if (!fileName) continue;
            if (includeMatchers.some((matcher) => matcher(fileName))) {
               if (
                  await copyEnvFileIfNeeded({
                     sourceRoot: sourcePath,
                     targetRoot: worktreePath,
                     relativePath: fileName,
                     warnings: envWarnings,
                  })
               ) {
                  copied++;
               }
            }
         }
      }

      if (envPaths.length > 0) {
         copied += await copyEnvPathsFromPatterns({
            sourceRoot: sourcePath,
            targetRoot: worktreePath,
            patterns: envPaths,
            warnings: envWarnings,
         });
      }
   } catch (err) {
      envWarnings.push(`Env init failed. ${yuString(err, { color: true })}`);
   }

   warnings.push(...envWarnings);
   return { copied, warnings: envWarnings };
}

/**
 * Collects file patterns to copy based on origin .gitignore and parallel.envPaths.
 */
async function collectEnvPatterns(
   worktreePath: string,
   config: Awaited<ReturnType<typeof getConfig>>,
   warnings: string[]
): Promise<EnvPatternSet> {
   const rootFiles = new Set<string>();
   const envPaths = new Set<string>();
   const gitignorePath = path.join(worktreePath, '.gitignore');
   if (fs.existsSync(gitignorePath)) {
      try {
         const raw = await fs.readFile(gitignorePath, 'utf-8');
         const lines = raw.split(/\r?\n/);
         for (const line of lines) {
            const normalized = line.trim();
            if (!normalized || normalized.startsWith('#')) continue;
            if (normalized.startsWith('!')) continue;
            if (normalized.endsWith('/')) continue;

            const stripped = normalized.startsWith('/') ? normalized.slice(1) : normalized;
            if (stripped.includes('/')) continue;
            rootFiles.add(stripped);
         }
      } catch (err) {
         warnings.push(`Failed to read .gitignore. ${yuString(err, { color: true })}`);
      }
   }

   const envPathsRaw = config.get('parallel.envPaths', '');
   if (typeof envPathsRaw === 'string') {
      const extraPatterns = envPathsRaw
         .split(':')
         .map((entry) => entry.trim())
         .filter((entry) => entry.length > 0);
      for (const pattern of extraPatterns) {
         envPaths.add(pattern);
      }
   }

   return {
      rootFiles: Array.from(rootFiles),
      envPaths: Array.from(envPaths),
   };
}

/**
 * Lists files at the repo root (no subdirectories).
 */
async function listRootFiles(worktreePath: string, warnings: string[]): Promise<string[]> {
   try {
      const entries = await fs.readdir(worktreePath, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
   } catch (err) {
      warnings.push(`Failed to list root files. ${yuString(err, { color: true })}`);
      return [];
   }
}

/**
 * Copies a file from source root to target root if missing in target.
 */
async function copyEnvFileIfNeeded(options: {
   sourceRoot: string;
   targetRoot: string;
   relativePath: string;
   warnings: string[];
}): Promise<boolean> {
   const { sourceRoot, targetRoot, relativePath, warnings } = options;
   if (path.resolve(sourceRoot) === path.resolve(targetRoot)) return false;
   const sourcePath = resolveEnvPath(sourceRoot, relativePath);
   const targetPath = resolveEnvPath(targetRoot, relativePath);
   if (!fs.existsSync(sourcePath)) return false;
   if (fs.existsSync(targetPath)) return false;
   try {
      const stats = await fs.stat(sourcePath);
      if (!stats.isFile()) return false;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const content = await fs.readFile(sourcePath);
      await fs.writeFile(targetPath, content);
      return true;
   } catch (err) {
      warnings.push(`Failed to copy env file '${relativePath}'. ${yuString(err, { color: true })}`);
      return false;
   }
}

/**
 * Copies a directory from source root to target root if missing in target.
 */
async function copyEnvDirectoryIfNeeded(options: {
   sourceRoot: string;
   targetRoot: string;
   relativePath: string;
   warnings: string[];
}): Promise<boolean> {
   const { sourceRoot, targetRoot, relativePath, warnings } = options;
   if (path.resolve(sourceRoot) === path.resolve(targetRoot)) return false;
   const sourcePath = resolveEnvPath(sourceRoot, relativePath);
   const targetPath = resolveEnvPath(targetRoot, relativePath);
   if (!fs.existsSync(sourcePath)) return false;
   if (fs.existsSync(targetPath)) return false;
   try {
      const stats = await fs.stat(sourcePath);
      if (!stats.isDirectory()) return false;
      await copyEnvDirectoryRecursive(sourcePath, targetPath, warnings);
      return true;
   } catch (err) {
      warnings.push(
         `Failed to copy env directory '${relativePath}'. ${yuString(err, { color: true })}`
      );
      return false;
   }
}

async function copyEnvDirectoryRecursive(
   sourceDir: string,
   targetDir: string,
   warnings: string[]
): Promise<void> {
   try {
      await fs.mkdir(targetDir, { recursive: true });
      const entries = await fs.readdir(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
         const sourcePath = path.join(sourceDir, entry.name);
         const targetPath = path.join(targetDir, entry.name);
         if (entry.isDirectory()) {
            await copyEnvDirectoryRecursive(sourcePath, targetPath, warnings);
         } else if (entry.isFile()) {
            const content = await fs.readFile(sourcePath);
            await fs.writeFile(targetPath, content);
         }
      }
   } catch (err) {
      warnings.push(`Failed to copy env directory. ${yuString(err, { color: true })}`);
   }
}

/**
 * Copies env paths that match glob-like patterns.
 */
async function copyEnvPathsFromPatterns(options: {
   sourceRoot: string;
   targetRoot: string;
   patterns: string[];
   warnings: string[];
}): Promise<number> {
   const { sourceRoot, targetRoot, patterns, warnings } = options;
   if (patterns.length === 0) return 0;

   const matchers = patterns
      .map((pattern) => buildPathGlobMatcher(pattern))
      .filter((matcher): matcher is (value: string) => boolean => Boolean(matcher));
   if (matchers.length === 0) return 0;

   let copied = 0;

   const walk = async (currentPath: string, relativePrefix: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
      try {
         entries = await fs.readdir(currentPath, { withFileTypes: true });
      } catch (err) {
         warnings.push(`Failed to read env paths. ${yuString(err, { color: true })}`);
         return;
      }

      for (const entry of entries) {
         const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
         const matches = matchers.some((matcher) => matcher(relativePath));

         if (matches && entry.isDirectory()) {
            const didCopy = await copyEnvDirectoryIfNeeded({
               sourceRoot,
               targetRoot,
               relativePath,
               warnings,
            });
            if (didCopy) {
               copied++;
               continue;
            }
         }

         if (matches && entry.isFile()) {
            if (
               await copyEnvFileIfNeeded({
                  sourceRoot,
                  targetRoot,
                  relativePath,
                  warnings,
               })
            ) {
               copied++;
            }
         }

         if (entry.isDirectory()) {
            await walk(path.join(currentPath, entry.name), relativePath);
         }
      }
   };

   await walk(sourceRoot, '');
   return copied;
}

/**
 * Resolves a forward-slash relative path under the given root.
 */
function resolveEnvPath(root: string, relativePath: string): string {
   const parts = relativePath.split('/').filter(Boolean);
   return path.join(root, ...parts);
}

/**
 * Gets env copy patterns from the origin .gitignore and parallel.envPaths.
 */
export async function getEnvCopyPatterns(originPath: string): Promise<string[]> {
   const config = await getConfig();
   const patterns = await collectEnvPatterns(originPath, config, []);
   return [...patterns.rootFiles, ...patterns.envPaths];
}

function detectJsPackageManager(worktreePath: string, warnings: string[]): PackageManager | null {
   const packageJsonPath = path.join(worktreePath, 'package.json');
   const hasPackageJson = fs.existsSync(packageJsonPath);

   const bunLockPath = path.join(worktreePath, 'bun.lockb');
   const bunLockTextPath = path.join(worktreePath, 'bun.lock');
   const pnpmLockPath = path.join(worktreePath, 'pnpm-lock.yaml');
   const npmLockPath = path.join(worktreePath, 'package-lock.json');
   const npmShrinkwrapPath = path.join(worktreePath, 'npm-shrinkwrap.json');

   let packageManager: PackageManager | null = null;

   if (hasPackageJson) {
      const declared = readPackageManager(packageJsonPath, warnings);
      if (declared) {
         packageManager = declared;
      }
   }

   if (!packageManager) {
      if (fs.existsSync(bunLockPath) || fs.existsSync(bunLockTextPath)) {
         packageManager = 'bun';
      } else if (fs.existsSync(pnpmLockPath)) {
         packageManager = 'pnpm';
      } else if (
         hasPackageJson &&
         (fs.existsSync(npmLockPath) || fs.existsSync(npmShrinkwrapPath))
      ) {
         packageManager = 'npm';
      } else if (hasPackageJson) {
         packageManager = 'npm';
      }
   }

   return packageManager;
}

function readPackageManager(packageJsonPath: string, warnings: string[]): PackageManager | null {
   try {
      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(content) as { packageManager?: string };
      const declared = parsed.packageManager?.split('@')[0]?.trim().toLowerCase();

      if (declared === 'npm' || declared === 'pnpm' || declared === 'bun') {
         return declared;
      }

      if (declared) {
         warnings.push(
            `Unsupported packageManager '${declared}' in package.json. ` +
               'Supported: npm, pnpm, bun.'
         );
      }
   } catch (err) {
      warnings.push(`Failed to parse package.json: ${yuString(err, { color: true })}`);
   }

   return null;
}

function detectUvProject(worktreePath: string): boolean {
   const uvLockPath = path.join(worktreePath, 'uv.lock');
   const pyprojectPath = path.join(worktreePath, 'pyproject.toml');
   return fs.existsSync(uvLockPath) || fs.existsSync(pyprojectPath);
}

async function runPackageInstall(
   manager: PackageManager,
   worktreePath: string,
   warnings: string[]
): Promise<boolean> {
   const resolved = await whichExec(manager);
   if (!resolved) {
      warnings.push(`Package manager '${manager}' not found in PATH. Skipping install.`);
      return false;
   }

   const $cwd = $({ cwd: worktreePath, stdout: 'inherit', stderr: 'inherit' });

   try {
      if (manager === 'npm') {
         await $cwd`npm install`;
      } else if (manager === 'pnpm') {
         await $cwd`pnpm install`;
      } else {
         await $cwd`bun install`;
      }
      return true;
   } catch (err) {
      warnings.push(`Package install failed for '${manager}'. ${yuString(err, { color: true })}`);
      return false;
   }
}

async function runUvSync(worktreePath: string, warnings: string[]): Promise<boolean> {
   const resolved = await whichExec('uv');
   if (!resolved) {
      warnings.push(`Package manager 'uv' not found in PATH. Skipping install.`);
      return false;
   }

   const $cwd = $({ cwd: worktreePath, stdout: 'inherit', stderr: 'inherit' });

   try {
      await $cwd`uv sync`;
      return true;
   } catch (err) {
      warnings.push(`Package install failed for 'uv'. ${yuString(err, { color: true })}`);
      return false;
   }
}
