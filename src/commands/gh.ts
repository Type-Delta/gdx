import path from 'path';
import { parse as parseToml } from 'smol-toml';

import { ncc, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, SGR } from '@/consts';
import { ArgsSet } from '@/modules/arguments';
import { execCommand, isTTY, $prompt, spinner, $, $inherit, printCommandExecution } from '@/modules/shell';
import { getRepoRootCached } from '@/modules/git';
import { existsSync, readdir, readFile } from '@/modules/fs';
import { quickPrint } from '@/utils/utilities';
import litedent from '@/utils/litedent';
import global from '@/global';

type RepoCreateMode = 'scratch' | 'template' | 'push';

interface RepoCreatePlan {
   mode: RepoCreateMode;
   args: string[];
   summary: string[];
}

interface RepoCreatePrompt {
   (question: string): Promise<string>;
}

/**
 * Routes `gdx gh ...` commands through GitHub CLI wrappers before falling back to `gh`.
 * @param ctx - Current gdx context.
 * @param gh$ - Resolved GitHub CLI executable.
 * @returns Process exit code.
 */
async function gh(ctx: GdxContext, gh$: string): Promise<number> {
   const ghArgs = ctx.args.slice(1);

   if (ghArgs[0] === 'repo' && ghArgs[1] === 'create' && isTTY()) {
      return repoCreate(ctx, gh$, new ArgsSet(ghArgs));
   }

   printCommandExecution('gh', ghArgs);
   return execCommand(gh$, ghArgs, 'gh');
}

/**
 * Wraps `gh repo create` by collecting obvious answers up front and running non-interactively.
 * @param ctx - Current gdx context.
 * @param gh$ - Resolved GitHub CLI executable.
 * @param args - Arguments relative to `gh`.
 * @returns Process exit code.
 */
async function repoCreate(ctx: GdxContext, gh$: string, args: ArgsSet): Promise<number> {
   const spinnerCtrl = spinner({ message: 'Checking authentication status...' });
   const authStatus = await $(gh$, ['auth', 'status']).then(() => 0).catch(() => 1);
   spinnerCtrl.stop();
   if (authStatus !== 0) return 1;

   const plan = await buildRepoCreatePlan(ctx, args, $prompt);
   printRepoCreateSummary(plan);
   const proceed = await $prompt('Proceed with these settings? (yes): ');
   if (!['', 'yes', 'y'].includes(proceed.trim().toLowerCase())) {
      quickPrint(SGR.red + 'Abort repository creation.' + SGR.reset);
      return 1;
   }

   printCommandExecution('gh', plan.args);
   await $inherit(gh$, plan.args);
   return 0;
}

/**
 * Builds non-interactive `gh repo create` arguments from the current project state.
 * @param ctx - Current gdx context.
 * @param inputArgs - Original arguments relative to `gh`.
 * @param prompt - Prompt implementation, injectable for tests.
 * @returns The final command plan.
 */
export async function buildRepoCreatePlan(
   ctx: GdxContext,
   inputArgs: ArgsSet,
   prompt: RepoCreatePrompt = $prompt
): Promise<RepoCreatePlan> {
   const args = new ArgsSet(inputArgs.slice(0));
   const repoCreateArgs = new ArgsSet(args.slice(2));
   let repoRoot: string | null;
   try {
      repoRoot = await getRepoRootCached(ctx.git$, true);
   } catch {
      repoRoot = null;
   }
   const isInsideRepo = repoRoot !== null;

   const mode = determineRepoCreateMode(repoCreateArgs, isInsideRepo);

   if (mode === 'push') {
      await fillPushExistingArgs(repoCreateArgs, repoRoot || process.cwd(), prompt);
   } else {
      await fillNewRepoArgs(repoCreateArgs, mode, isInsideRepo, prompt);
   }

   ensureVisibility(repoCreateArgs);

   return {
      mode,
      args: ['repo', 'create', ...repoCreateArgs],
      summary: buildRepoCreateSummary(mode, repoCreateArgs),
   };
}

/**
 * Selects the repo-create mode from provided flags and repository state.
 * @param args - Arguments after `gh repo create`.
 * @param isInsideRepo - Whether the current directory is in a git worktree.
 * @returns The selected mode.
 */
function determineRepoCreateMode(args: ArgsSet, isInsideRepo: boolean): RepoCreateMode {
   if (hasAnyOption(args, ['--template', '-p'])) return 'template';
   if (hasValueOption(args, '--source')) return 'push';
   if (isInsideRepo) return 'push';
   return 'scratch';
}

/**
 * Adds the non-interactive answers for creating a repo from scratch or a template.
 */
async function fillNewRepoArgs(
   args: ArgsSet,
   mode: Exclude<RepoCreateMode, 'push'>,
   isInsideRepo: boolean,
   prompt: RepoCreatePrompt
): Promise<void> {
   await ensureRepoName(args, process.cwd(), prompt, null);

   if (!hasValueOption(args, '--description')) {
      args.push('--description', await promptRequired(prompt, 'Repository description: '));
   }

   if (mode === 'scratch' && !hasValueOption(args, '--license')) {
      const license = await promptOptional(prompt, 'License template (blank for none): ');
      if (license) args.push('--license', license);
   }

   if (mode === 'scratch' && !hasAnyOption(args, ['--add-readme'])) {
      if (await hasReadme(process.cwd())) {
         args.push('--add-readme');
      }
   }

   if (!isInsideRepo && !hasAnyOption(args, ['--clone', '--no-clone'])) {
      args.push('--clone');
   }
}

/**
 * Adds the non-interactive answers for pushing an existing local repository.
 */
async function fillPushExistingArgs(
   args: ArgsSet,
   repoRoot: string,
   prompt: RepoCreatePrompt
): Promise<void> {
   if (!hasValueOption(args, '--source')) {
      args.push('--source', repoRoot);
   }

   const metadata = await getProjectMetadata(repoRoot);
   if (!getRepoNameArg(args)) {
      args.unshift(metadata.name || await promptRequired(prompt, 'Repository name: '));
   }

   if (!hasValueOption(args, '--description')) {
      const description = metadata.description || await promptRequired(prompt, 'Repository description: ');
      args.push('--description', description);
   }

   if (!hasValueOption(args, '--remote')) {
      args.push('--remote', 'origin');
   }

   if (!hasAnyOption(args, ['--push'])) {
      args.push('--push');
   }
}

/**
 * Ensures the command has a repository name positional argument.
 */
async function ensureRepoName(
   args: ArgsSet,
   fallbackDir: string,
   prompt: RepoCreatePrompt,
   preferredName?: string | null
): Promise<void> {
   if (getRepoNameArg(args)) return;

   const name = preferredName || await promptRequired(prompt, 'Repository name: ');
   args.unshift(name);
}

/**
 * Adds private visibility unless the user already selected visibility.
 */
function ensureVisibility(args: ArgsSet): void {
   if (!hasAnyOption(args, ['--public', '--private', '--internal'])) {
      args.push('--private');
   }
}

/**
 * Reads project metadata from common package manifests.
 */
async function getProjectMetadata(projectDir: string): Promise<{ name: string | null; description: string | null }> {
   const packageJsonPath = path.join(projectDir, 'package.json');
   if (existsSync(packageJsonPath)) {
      try {
         const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
            name?: unknown;
            description?: unknown;
         };
         return {
            name: typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : null,
            description: typeof pkg.description === 'string' && pkg.description.trim() ? pkg.description.trim() : null,
         };
      } catch {
         // Ignore malformed project metadata and fall back to the next source.
      }
   }

   const pyprojectPath = path.join(projectDir, 'pyproject.toml');
   if (existsSync(pyprojectPath)) {
      const parsed = parseToml(await readFile(pyprojectPath, 'utf-8')) as Record<string, unknown>;
      const project =
         parsed.project && typeof parsed.project === 'object'
            ? parsed.project as Record<string, unknown>
            : parsed;
      return {
         name: typeof project.name === 'string' && project.name.trim() ? project.name.trim() : null,
         description:
            typeof project.description === 'string' && project.description.trim()
               ? project.description.trim()
               : null,
      };
   }

   return { name: null, description: null };
}

/**
 * Checks for an existing README in the target directory.
 */
async function hasReadme(dir: string): Promise<boolean> {
   try {
      const entries = await readdir(dir);
      return entries.some((entry) => /^readme(?:\.|$)/i.test(entry));
   } catch {
      return false;
   }
}

/**
 * Returns the positional repository name argument, if present.
 */
function getRepoNameArg(args: string[]): string | null {
   for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') break;
      if (!arg.startsWith('-')) return arg;
      if (optionConsumesValue(arg) && !arg.includes('=') && i + 1 < args.length) i++;
   }
   return null;
}

/**
 * Checks whether an option is present, including `--flag=value` form.
 */
function hasValueOption(args: ArgsSet, option: string): boolean {
   return args.optionIndexOf(option) !== -1;
}

/**
 * Checks whether any option from the list is present.
 */
function hasAnyOption(args: ArgsSet, options: string[]): boolean {
   return options.some((option) => args.optionIndexOf(option) !== -1);
}

/**
 * Identifies options that consume the following token when scanning positionals.
 */
function optionConsumesValue(option: string): boolean {
   return [
      '--source',
      '--template',
      '-p',
      '--description',
      '--remote',
      '--team',
      '--gitignore',
      '--homepage',
      '--license',
   ].includes(option);
}

/**
 * Returns an option value from `--option value` or `--option=value` without mutating args.
 */
function getOptionValue(args: string[], option: string): string | null {
   for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') break;
      if (arg === option) return args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
      if (arg.startsWith(`${option}=`)) return arg.slice(option.length + 1) || null;
   }
   return null;
}

/**
 * Prompts until a non-empty answer is provided.
 */
async function promptRequired(prompt: RepoCreatePrompt, question: string): Promise<string> {
   while (true) {
      const value = (await prompt(question)).trim();
      if (value) return value;
   }
}

/**
 * Prompts once for an optional answer.
 */
async function promptOptional(prompt: RepoCreatePrompt, question: string): Promise<string | null> {
   const value = (await prompt(question)).trim();
   return value || null;
}

/**
 * Builds summary lines for the final confirmation display.
 */
function buildRepoCreateSummary(mode: RepoCreateMode, args: string[]): string[] {
   return [
      `Mode: ${mode === 'push' ? 'Push existing repository' : mode === 'template' ? 'Create from template' : 'Create from scratch'}`,
      `Name: ${getRepoNameArg(args) || '(from gh)'}`,
      `Description: ${getOptionValue(args, '--description') || '(none)'}`,
      `License: ${getOptionValue(args, '--license') || '(none)'}`,
      `Visibility: ${args.includes('--public') ? 'public' : args.includes('--internal') ? 'internal' : 'private'}`,
   ];
}

/**
 * Prints the repo-create summary before executing `gh`.
 */
function printRepoCreateSummary(plan: RepoCreatePlan): void {
   quickPrint(SGR.bright + ncc('Cyan') + 'gh repo create summary' + SGR.reset);
   quickPrint(plan.summary.map((line) => `  ${line}`).join('\n'));
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} gh${SGR.reset} routes commands to the GitHub CLI through gdx.

         Most commands are forwarded directly to ${SGR.cyan}gh${SGR.reset}. In an interactive TTY,
         ${SGR.cyan}${EXECUTABLE_NAME} gh repo create${SGR.reset} first checks ${SGR.cyan}gh auth status${SGR.reset},
         then fills obvious answers and runs ${SGR.cyan}gh repo create${SGR.reset} non-interactively.

         Existing git repositories are pushed as the current local repo. Outside a git repo,
         the wrapper creates a repository from scratch. Template creation is used only when
         ${SGR.cyan}--template${SGR.reset} or ${SGR.cyan}-p${SGR.reset} is provided explicitly.`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'Route commands to GitHub CLI with gdx wrappers for selected gh workflows.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} gh <gh-command> [<args>]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} gh repo list${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} gh repo create${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} gh repo create my-repo --public${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} gh repo create my-repo -p owner/template${SGR.reset}`,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
} as const satisfies CommandHelpObj;

export const structure = {
   $root: {
      repo: {
         create: {
            $anyOf: [
               '--source',
               '--template',
               '-p',
               '--description',
               '--remote',
               '--public',
               '--private',
               '--internal',
               '--clone',
               '--no-clone',
               '--add-readme',
               '--license',
               '--push',
            ],
         },
      },
   },
} as const satisfies CommandStructure;

export default gh;
