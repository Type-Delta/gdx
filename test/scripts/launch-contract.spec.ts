import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it as bunIt } from 'bun:test';
import litedent from 'litedent';

import { whichExec } from '@/modules/shell';
import { createTestEnv } from '@/utils/testHelper';

describe('source launch contract', async () => {
   const { tmpDir, it } = await createTestEnv({ suitName: 'launch-contract' });
   const sourceEntry = path.resolve(import.meta.dir, '../../src/index.ts');
   const resolvedGitExe = await whichExec('git', { noCache: true });

   if (!resolvedGitExe) throw new Error('Git executable not found in PATH.');
   const gitExe: string = resolvedGitExe;
   const itPosix = process.platform === 'win32' ? bunIt.skip : bunIt;

   function childEnv(): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = {
         ...process.env,
         GDX_CONFIG_PATH: process.env.GDX_CONFIG_PATH,
         GDX_CURRENT_DIR: tmpDir,
         GDX_TEMP_DIR: process.env.GDX_TEMP_DIR,
         GDX_HISTORY_ENABLED: 'false',
         GDX_ENHANCED_OUTPUT: 'false',
         GDX_WRITE_LOGS: '0',
      };
      delete env.GDX_HISTORY_GUARD;
      delete env.GDX_RUNTIME_SHIM;
      delete env.GDX_NODE_SHIM;
      return env;
   }

   function run(
      executable: string,
      args: string[],
      input?: Buffer,
      env = childEnv()
   ): Promise<{
      stdout: Buffer;
      stderr: Buffer;
      status: number | null;
      signal: NodeJS.Signals | null;
   }> {
      return new Promise((resolve, reject) => {
         const child = spawn(executable, args, {
            cwd: tmpDir,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
         });
         const stdout: Buffer[] = [];
         const stderr: Buffer[] = [];

         child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
         child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
         child.once('error', reject);
         child.once('close', (status, signal) =>
            resolve({
               stdout: Buffer.concat(stdout),
               stderr: Buffer.concat(stderr),
               status,
               signal,
            })
         );
         child.stdin.end(input);
      });
   }

   async function runGit(args: string[], input?: Buffer, env?: NodeJS.ProcessEnv) {
      return await run(gitExe, args, input, env);
   }

   async function runGdx(args: string[], input?: Buffer, env?: NodeJS.ProcessEnv) {
      return await run(process.execPath, [sourceEntry, ...args], input, env);
   }

   function runPipeline(
      executable: string,
      prefix: string[],
      args: string[],
      input: Buffer
   ): Promise<{
      stdout: Buffer;
      stderr: Buffer[];
      statuses: Array<{ status: number | null; signal: NodeJS.Signals | null }>;
   }> {
      return new Promise((resolve, reject) => {
         const children = [0, 1].map(() =>
            spawn(executable, [...prefix, ...args], {
               cwd: tmpDir,
               env: childEnv(),
               stdio: ['pipe', 'pipe', 'pipe'],
               windowsHide: true,
            })
         );
         children[0].stdout.pipe(children[1].stdin);
         const stdout: Buffer[] = [];
         const stderr: Buffer[][] = [[], []];
         children[1].stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
         children.forEach((child, index) => {
            child.stderr.on('data', (chunk: Buffer) => stderr[index].push(chunk));
            child.once('error', reject);
         });
         Promise.all(
            children.map(
               (child) =>
                  new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((done) =>
                     child.once('close', (status, signal) => done({ status, signal }))
                  )
            )
         ).then((statuses) =>
            resolve({
               stdout: Buffer.concat(stdout),
               stderr: stderr.map((chunks) => Buffer.concat(chunks)),
               statuses,
            })
         );
         children[0].stdin.end(input);
      });
   }

   it('matches Git for wrapper-looking arguments after the command and separator', async () => {
      for (const args of [
         ['rev-parse', '--', '--ghelp'],
         ['-cfoo.bar=baz', 'rev-parse', '--is-inside-work-tree'],
      ]) {
         const expected = await runGit(args);
         const actual = await runGdx(args);
         expect(actual, args.join(' ')).toEqual(expected);
      }
   });

   it('does not leak gdx-only environment markers into Git children', async () => {
      const args = [
         '-c',
         `alias.gdx-env=!printf '%s|%s|%s|%s\\n' \"$GDX_HISTORY_GUARD\" \"$GDX_RUNTIME_SHIM\" \"$GDX_NODE_SHIM\" \"$GDX_RUNTIME_PATH_FALLBACK\"`,
         'gdx-env',
      ];
      const expectedEnv = { ...childEnv(), GDX_HISTORY_GUARD: 'preset' };
      const gdxEnv = {
         ...expectedEnv,
         GDX_RUNTIME_SHIM: '1',
         GDX_NODE_SHIM: '1',
         GDX_RUNTIME_PATH_FALLBACK: '1',
      };
      const expected = await runGit(args, undefined, expectedEnv);
      expect(expected.status).toBe(0);
      expect(expected.stdout).toEqual(Buffer.from('preset|||\n'));
      expect(await runGdx(args, undefined, gdxEnv)).toEqual(expected);
   });

   it('preserves stdin and exact stdout/stderr buffers with ordinary exit codes', async () => {
      const input = Buffer.from('gdx launch contract\n\0binary\n');
      const stdinArgs = ['hash-object', '--stdin'];
      expect(await runGdx(stdinArgs, input)).toEqual(await runGit(stdinArgs, input));

      const successArgs = ['rev-parse', '--is-inside-work-tree'];
      expect(await runGdx(successArgs)).toEqual(await runGit(successArgs));

      const failureArgs = ['rev-parse', '--verify', 'refs/heads/__gdx_missing__'];
      expect(await runGdx(failureArgs)).toEqual(await runGit(failureArgs));
   });

   it('matches a two-stage Git stdin/stdout pipeline', async () => {
      const args = ['hash-object', '--stdin'];
      const input = Buffer.from('gdx chained pipeline\n\0binary\n');
      expect(await runPipeline(process.execPath, [sourceEntry], args, input)).toEqual(
         await runPipeline(gitExe, [], args, input)
      );
   });

   itPosix('propagates a signal-terminated forwarded child', async () => {
      const nodeExe = await whichExec('node', { noCache: true });
      if (!nodeExe) throw new Error('Node executable not found in PATH.');

      const selfTerminate = "process.kill(process.pid, 'SIGTERM')";
      const direct = await run(nodeExe, ['-e', selfTerminate]);
      expect(direct.status).toBeNull();
      expect(direct.signal).toBe('SIGTERM');

      const shellModule = pathToFileURL(
         path.resolve(import.meta.dir, '../../src/modules/shell.ts')
      ).href;
      const probe = litedent`
         import { execCommand } from ${JSON.stringify(shellModule)};
         await execCommand(${JSON.stringify(nodeExe)}, ['-e', ${JSON.stringify(selfTerminate)}], 'probe', null, '>', false);
      `;
      expect(await run(process.execPath, ['-e', probe])).toEqual(direct);
   });

   itPosix('returns failure when a forwarded executable cannot spawn', async () => {
      const shellModule = pathToFileURL(
         path.resolve(import.meta.dir, '../../src/modules/shell.ts')
      ).href;
      const missing = path.join(tmpDir, '__gdx_missing_executable__');
      const probe = litedent`
         import { execCommand } from ${JSON.stringify(shellModule)};
         process.exit(await execCommand(${JSON.stringify(missing)}, [], 'probe', null, '>', false));
      `;
      const result = await run(process.execPath, ['-e', probe]);
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
   });
});
