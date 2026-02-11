import path from 'path';

import { yuString } from '@lib/Tools';

import * as fs from '@/modules/fs';
import { $, spinner, whichExec } from '@/modules/shell';
import Logger from '@/utils/logger';
import { getConfig } from '@/common/config';
import { initSubmodules } from '@/modules/git';

export type WorktreeInitBehavior = 'submodule' | 'pkg';

export interface WorktreeInitOptions {
   git$: string | string[];
   worktreePath: string;
   noInitAll?: boolean;
   noInitList?: string | null;
}

const INIT_BEHAVIOR_SET = new Set<WorktreeInitBehavior>(['submodule', 'pkg']);

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

      const configValue = config.get('parallel.init', 'submodule');
      const parsedConfig = parseBehaviorList(configValue);
      if (parsedConfig.invalid.length > 0) {
         warnings.push(
            `Unknown parallel.init values: ${parsedConfig.invalid.join(', ')}. ` +
            'Valid values: submodule, pkg.'
         );
      }

      const parsedNoInit = parseBehaviorList(options.noInitList);
      if (parsedNoInit.invalid.length > 0) {
         warnings.push(
            `Unknown --no-init values: ${parsedNoInit.invalid.join(', ')}. ` +
            'Valid values: submodule, pkg.'
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
            message: 'Initializing git submodules...'
         });
         try {
            await initSubmodules(options.git$, options.worktreePath);
         } catch (err) {
            spinnerCtrl.stop();
            warnings.push(`Submodule init failed. ${yuString(err, { color: true })}`);
         }
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
