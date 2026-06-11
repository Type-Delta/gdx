import path from 'path';
import { parse as parseToml } from 'smol-toml';

import { ncc, strWrap } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '@/common/types';
import { EXECUTABLE_NAME, SGR } from '@/consts';
import { ArgsSet } from '@/modules/arguments';
import { execCommand, isTTY, $prompt, spinner, $, $inherit, printCommandExecution } from '@/modules/shell';
import { getRepoRootCached } from '@/modules/git';
import { existsSync, readFile } from '@/modules/fs';
import { quickPrint } from '@/utils/utilities';
import litedent from '@/utils/litedent';
import global from '@/global';
import { Form } from '@/modules/form';

type RepoCreateMode = 'scratch' | 'template' | 'push';

interface RepoCreatePlan {
   mode: RepoCreateMode;
   args: string[];
   summary: string[];
}

/**
 * A question the repo-create wrapper needs answered before it can run
 * `gh repo create` non-interactively.
 */
export interface RepoCreateQuestion {
   key: 'name' | 'description' | 'license' | 'visibility';
   type: 'textbox' | 'dropdown' | 'choice';
   title: string;
   description?: string;
   optional?: boolean;
   options?: string[];
   initial?: string;
}

/**
 * Collects answers for repo-create questions.
 * Implementations: Form TUI (rich terminals) and `$prompt` (fallback).
 * @returns Answers keyed by question key (null = skipped), or null when the user aborted.
 */
export type RepoCreateAsk = (
   questions: RepoCreateQuestion[]
) => Promise<Record<string, string | null> | null>;

/** License keys accepted by `gh repo create --license`. */
const REPO_CREATE_LICENSES = [
   'mit',
   'apache-2.0',
   'gpl-3.0',
   'agpl-3.0',
   'lgpl-2.1',
   'mpl-2.0',
   'bsd-2-clause',
   'bsd-3-clause',
   'bsl-1.0',
   'cc0-1.0',
   'epl-2.0',
   'gpl-2.0',
   'unlicense',
];

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
 * Uses the full-screen Form TUI when the terminal supports it, plain prompts otherwise.
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

   const { canUseDiffViewer } = await import('@/modules/diff-viewer');
   const useForm = canUseDiffViewer();

   const plan = await buildRepoCreatePlan(ctx, args, useForm ? askWithForm : askWithPrompt);
   if (!plan) {
      quickPrint(SGR.red + 'Abort repository creation.' + SGR.reset);
      return 1;
   }

   let proceed: boolean;
   if (useForm) {
      const result = await new Form({ title: 'GitHub · Create repository' })
         .confirm('proceed', 'Create repository with these settings?', {
            body: plan.summary,
            actions: [
               { label: 'Create repository', value: true },
               { label: 'Abort', value: false },
            ],
         })
         .run();
      proceed = result.completed && result.answers.proceed === true;
      // Keep a record of the settings in the scrollback after the form clears the screen
      printRepoCreateSummary(plan);
   } else {
      printRepoCreateSummary(plan);
      const answer = await $prompt('Proceed with these settings? (yes): ');
      proceed = ['', 'yes', 'y'].includes(answer.trim().toLowerCase());
   }

   if (!proceed) {
      quickPrint(SGR.red + 'Abort repository creation.' + SGR.reset);
      return 1;
   }

   printCommandExecution('gh', plan.args);
   await $inherit(gh$, plan.args);
   return 0;
}

/**
 * Answers repo-create questions through the full-screen Form TUI.
 * @param questions - Questions to present.
 * @returns Collected answers, or null when the user exited the form early.
 */
async function askWithForm(
   questions: RepoCreateQuestion[]
): Promise<Record<string, string | null> | null> {
   const form = new Form({ title: 'GitHub · Create repository' });

   for (const question of questions) {
      switch (question.type) {
         case 'textbox':
            form.textbox(question.key, question.title, {
               description: question.description,
               optional: question.optional,
               initial: question.initial,
            });
            break;
         case 'dropdown':
            form.dropdown(question.key, question.title, question.options ?? [], {
               description: question.description,
               optional: question.optional,
               placeholder: 'Type to filter...',
            });
            break;
         case 'choice':
            form.choice(question.key, question.title, question.options ?? [], {
               description: question.description,
               optional: question.optional,
               initial: question.initial,
            });
            break;
      }
   }

   const result = await form.run();
   if (!result.completed) return null;
   return result.answers as Record<string, string | null>;
}

/**
 * Answers repo-create questions with sequential `$prompt` calls.
 * @param questions - Questions to present.
 * @returns Collected answers (never aborts; Ctrl+C exits the process).
 */
async function askWithPrompt(
   questions: RepoCreateQuestion[]
): Promise<Record<string, string | null> | null> {
   const answers: Record<string, string | null> = {};

   for (const question of questions) {
      const hint = question.options?.length && question.type === 'choice'
         ? ` (${question.options.join('/')})`
         : '';
      const fallback = question.initial
         ? ` [${question.initial}]`
         : question.optional
            ? ' (blank for none)'
            : '';

      while (true) {
         const value = (await $prompt(`${question.title}${hint}${fallback}: `)).trim();
         if (!value) {
            if (question.initial) {
               answers[question.key] = question.initial;
               break;
            }
            if (question.optional) {
               answers[question.key] = null;
               break;
            }
            continue;
         }
         if (question.type === 'choice' && question.options && !question.options.includes(value.toLowerCase())) {
            quickPrint(
               SGR.red + `Invalid value. Choose one of: ${question.options.join(', ')}` + SGR.reset
            );
            continue;
         }
         answers[question.key] = question.type === 'choice' ? value.toLowerCase() : value;
         break;
      }
   }

   return answers;
}

/**
 * Builds non-interactive `gh repo create` arguments from the current project state.
 * Missing values are collected through the provided asker in a single pass.
 * @param ctx - Current gdx context.
 * @param inputArgs - Original arguments relative to `gh`.
 * @param ask - Question asker implementation, injectable for tests.
 * @returns The final command plan, or null when the user aborted.
 */
export async function buildRepoCreatePlan(
   ctx: GdxContext,
   inputArgs: ArgsSet,
   ask: RepoCreateAsk = askWithPrompt
): Promise<RepoCreatePlan | null> {
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
   const metadata =
      mode === 'push'
         ? await getProjectMetadata(repoRoot || process.cwd())
         : { name: null, description: null };

   const questions: RepoCreateQuestion[] = [];
   if (!getRepoNameArg(repoCreateArgs) && !metadata.name) {
      questions.push({
         key: 'name',
         type: 'textbox',
         title: 'Repository name',
         description: 'Name of the new GitHub repository.',
      });
   }
   if (!hasValueOption(repoCreateArgs, '--description') && !metadata.description) {
      questions.push({
         key: 'description',
         type: 'textbox',
         title: 'Repository description',
         optional: true,
         description: 'Short description shown on the repository page.',
      });
   }
   if (mode === 'scratch' && !hasValueOption(repoCreateArgs, '--license')) {
      questions.push({
         key: 'license',
         type: 'dropdown',
         title: 'License template',
         description: 'Open source license to initialize the repository with.',
         optional: true,
         options: REPO_CREATE_LICENSES,
      });
   }
   if (!hasAnyOption(repoCreateArgs, ['--public', '--private', '--internal'])) {
      questions.push({
         key: 'visibility',
         type: 'choice',
         title: 'Repository visibility',
         description: 'Controls who can see the new repository.',
         options: ['private', 'public', 'internal'],
         initial: 'private',
      });
   }

   const answers = questions.length > 0 ? await ask(questions) : {};
   if (answers === null) return null;

   const name = getRepoNameArg(repoCreateArgs) || metadata.name || answers['name'] || null;
   const description = hasValueOption(repoCreateArgs, '--description')
      ? null
      : metadata.description || answers['description'] || null;
   if (!name) return null;

   if (mode === 'push') {
      fillPushExistingArgs(repoCreateArgs, repoRoot || process.cwd(), name, description);
   } else {
      fillNewRepoArgs(repoCreateArgs, mode, isInsideRepo, name, description, answers);
   }

   applyVisibility(repoCreateArgs, answers['visibility'] ?? null);

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
function fillNewRepoArgs(
   args: ArgsSet,
   mode: Exclude<RepoCreateMode, 'push'>,
   isInsideRepo: boolean,
   name: string,
   description: string | null,
   answers: Record<string, string | null>
): void {
   if (!getRepoNameArg(args)) args.unshift(name);

   if (!hasValueOption(args, '--description') && description) {
      args.push('--description', description);
   }

   if (mode === 'scratch' && !hasValueOption(args, '--license') && answers['license']) {
      args.push('--license', answers['license']);
   }

   if (!isInsideRepo && !hasAnyOption(args, ['--clone', '--no-clone'])) {
      args.push('--clone');
   }
}

/**
 * Adds the non-interactive answers for pushing an existing local repository.
 */
function fillPushExistingArgs(
   args: ArgsSet,
   repoRoot: string,
   name: string,
   description: string | null
): void {
   if (!hasValueOption(args, '--source')) {
      args.push('--source', repoRoot);
   }

   if (!getRepoNameArg(args)) {
      args.unshift(name);
   }

   if (!hasValueOption(args, '--description') && description) {
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
 * Applies the selected visibility, defaulting to private when none was chosen.
 */
function applyVisibility(args: ArgsSet, visibility: string | null): void {
   if (!hasAnyOption(args, ['--public', '--private', '--internal'])) {
      args.push(`--${visibility || 'private'}`);
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
         Missing values (name, description, license, visibility) are collected through a
         full-screen form on rich terminals, or plain prompts otherwise. In the form,
         ${SGR.cyan}Shift+Right${SGR.reset} skips/advances and ${SGR.cyan}Shift+Left${SGR.reset} goes back (${SGR.cyan}Tab${SGR.reset}/${SGR.cyan}Shift+Tab${SGR.reset} also work).

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
