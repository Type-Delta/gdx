import { beforeEach, describe, expect, mock, test } from 'bun:test';

type KeytarMock = {
   getPassword(service: string, account: string): Promise<string | null>;
   setPassword(service: string, account: string, password: string): Promise<void>;
   deletePassword(service: string, account: string): Promise<boolean>;
};

type ExecaCall = {
   command: string;
   args: string[];
   options: Record<string, unknown>;
};

const keytar: KeytarMock = {
   getPassword: async () => null,
   setPassword: async () => {},
   deletePassword: async () => false,
};
const execaCalls: ExecaCall[] = [];
const keytarCalls: string[] = [];
let execaImplementation = async (
   command: string,
   args: string[],
   options: Record<string, unknown>
) => {
   execaCalls.push({ command, args, options });
   return { stdout: '', stderr: '', exitCode: 0, failed: false };
};

mock.module('keytar', () => ({ default: keytar }));
mock.module('execa', () => ({
   execa: (
      command: string,
      args: string[],
      options: Record<string, unknown>
   ) => execaImplementation(command, args, options),
}));

const { SecretStoreError, getSecretStore } = await import('@/modules/secret-store');

describe('secret store', () => {
   beforeEach(() => {
      keytar.getPassword = async () => {
         keytarCalls.push('getPassword');
         return null;
      };
      keytar.setPassword = async () => {
         keytarCalls.push('setPassword');
      };
      keytar.deletePassword = async () => {
         keytarCalls.push('deletePassword');
         return false;
      };
      keytarCalls.length = 0;
      execaCalls.length = 0;
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         if (args[0] === 'show') {
            return {
               stdout: '',
               stderr: `Error: ${args.at(-1)} is not in the password store.`,
               exitCode: 1,
               failed: true,
            };
         }
         return { stdout: '', stderr: '', exitCode: 0, failed: false };
      };
   });

   test('defaults to the auto provider', () => {
      expect(getSecretStore()).toBe(getSecretStore('auto'));
      expect(getSecretStore('auto')).not.toBe(getSecretStore('keychain'));
      expect(getSecretStore('auto')).not.toBe(getSecretStore('pass'));
   });

   test('uses only keytar when keychain is selected', async () => {
      const secret = 'keychain-only-secret';
      keytar.getPassword = async () => {
         keytarCalls.push('getPassword');
         return secret;
      };
      keytar.deletePassword = async () => {
         keytarCalls.push('deletePassword');
         return true;
      };

      const store = getSecretStore('keychain');
      await expect(store.getPassword('gdx', 'llm.apiKey')).resolves.toBe(secret);
      await store.setPassword('gdx', 'llm.apiKey', secret);
      await expect(store.deletePassword('gdx', 'llm.apiKey')).resolves.toBe(true);

      expect(keytarCalls).toEqual(['getPassword', 'setPassword', 'deletePassword']);
      expect(execaCalls).toHaveLength(0);
   });

   test('wraps keychain failures without falling back to pass', async () => {
      const secret = 'never-print-keychain-secret';
      keytar.setPassword = async () => {
         keytarCalls.push('setPassword');
         throw new Error(`keychain rejected ${secret}`);
      };

      try {
         await getSecretStore('keychain').setPassword('gdx', 'llm.apiKey', secret);
         throw new Error('Expected setPassword to fail');
      } catch (error) {
         expect(error).toBeInstanceOf(SecretStoreError);
         expect(String(error)).toContain('keytar');
         expect(String(error)).not.toContain(secret);
      }
      expect(execaCalls).toHaveLength(0);
   });

   test('uses only pass when pass is selected', async () => {
      const secret = 'pass-only-secret\n';
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         return {
            stdout: args[0] === 'show' ? secret : '',
            stderr: '',
            exitCode: 0,
            failed: false,
         };
      };

      const store = getSecretStore('pass');
      await expect(store.getPassword('../gdx', '../../llm.apiKey')).resolves.toBe(secret);
      await store.setPassword('../gdx', '../../llm.apiKey', secret);
      await expect(store.deletePassword('../gdx', '../../llm.apiKey')).resolves.toBe(true);

      expect(keytarCalls).toHaveLength(0);
      expect(execaCalls.map(({ args }) => args[0])).toEqual(['show', 'insert', 'rm']);
      expect(execaCalls[0].options.stripFinalNewline).toBe(false);
      expect(execaCalls[0].args[1]).toMatch(/^gdx\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
      expect(execaCalls[1].args.join(' ')).not.toContain(secret);
      expect(execaCalls[1].options.input).toBe(secret);
   });

   test('wraps pass failures without invoking keytar', async () => {
      const secret = 'never-print-pass-secret';
      execaImplementation = async () => {
         throw new Error(`pass rejected ${secret}`);
      };

      try {
         await getSecretStore('pass').setPassword('gdx', 'llm.apiKey', secret);
         throw new Error('Expected setPassword to fail');
      } catch (error) {
         expect(error).toBeInstanceOf(SecretStoreError);
         expect(String(error)).toContain('pass');
         expect(String(error)).not.toContain(secret);
      }
      expect(keytarCalls).toHaveLength(0);
   });

   test('returns a keytar secret when pass has no fallback entry', async () => {
      keytar.getPassword = async () => 'from-keytar';

      await expect(getSecretStore().getPassword('gdx', 'llm.apiKey')).resolves.toBe('from-keytar');
      expect(execaCalls).toHaveLength(process.platform === 'linux' ? 1 : 0);
   });

   test('prefers and reconciles a pass fallback created during a keytar outage', async () => {
      if (process.platform !== 'linux') return;

      keytar.getPassword = async () => 'stale-keytar';
      let reconciledValue: string | undefined;
      keytar.setPassword = async (_service, _account, password) => {
         reconciledValue = password;
      };
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         return {
            stdout: args[0] === 'show' ? 'fresh-pass' : '',
            stderr: '',
            exitCode: 0,
            failed: false,
         };
      };

      await expect(getSecretStore().getPassword('gdx', 'llm.apiKey')).resolves.toBe('fresh-pass');
      expect(reconciledValue).toBe('fresh-pass');
      expect(execaCalls.map(({ args }) => args[0])).toEqual(['show', 'rm']);
   });

   test('preserves a trailing newline in a pass secret', async () => {
      if (process.platform !== 'linux') return;

      keytar.getPassword = async () => {
         throw new Error('keychain unavailable');
      };
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         return { stdout: 'secret\n', stderr: '', exitCode: 0, failed: false };
      };

      await expect(getSecretStore().getPassword('gdx', 'multiline')).resolves.toBe('secret\n');
      expect(execaCalls[0].options.stripFinalNewline).toBe(false);
   });

   test('discovers a pass secret when keytar has no entry', async () => {
      if (process.platform !== 'linux') return;
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         return { stdout: 'from-pass', stderr: '', exitCode: 0, failed: false };
      };

      await expect(getSecretStore().getPassword('../gdx', '../../llm.apiKey')).resolves.toBe(
         'from-pass'
      );
      expect(execaCalls[0].command).toBe('pass');
      expect(execaCalls[0].args[0]).toBe('show');
      expect(execaCalls[0].args[1]).toMatch(/^gdx\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
      expect(execaCalls[0].args[1]).not.toContain('..');
   });

   test('falls back to pass on Linux and sends a written secret only through stdin', async () => {
      if (process.platform !== 'linux') return;
      const secret = 'do-not-put-this-in-argv';
      keytar.setPassword = async () => {
         throw new Error('login collection is unavailable');
      };
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         if (args[0] === 'show') {
            return {
               stdout: '',
               stderr: `Error: ${args.at(-1)} is not in the password store.`,
               exitCode: 1,
               failed: true,
            };
         }
         return { stdout: '', stderr: '', exitCode: 0, failed: false };
      };

      await getSecretStore().setPassword('gdx', 'llm.apiKey', secret);

      const insertCall = execaCalls.find(({ args }) => args[0] === 'insert');
      expect(insertCall?.args.slice(0, 3)).toEqual(['insert', '--multiline', '--force']);
      expect(insertCall?.args.join(' ')).not.toContain(secret);
      expect(insertCall?.options.input).toBe(secret);
   });

   test('deletes both keytar and pass entries', async () => {
      if (process.platform !== 'linux') return;
      let keytarDeleted = false;
      keytar.deletePassword = async () => {
         keytarDeleted = true;
         return true;
      };

      await expect(getSecretStore().deletePassword('gdx', 'llm.apiKey')).resolves.toBe(true);
      expect(keytarDeleted).toBe(true);
      expect(execaCalls[0].args[0]).toBe('rm');
      expect(execaCalls[0].args[1]).toBe('--force');
   });

   test('reports a pass deletion failure instead of leaving a fallback secret behind', async () => {
      if (process.platform !== 'linux') return;
      keytar.deletePassword = async () => true;
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         return {
            stdout: '',
            stderr: 'gpg could not decrypt the password store',
            exitCode: 2,
            failed: true,
         };
      };

      await expect(getSecretStore().deletePassword('gdx', 'llm.apiKey')).rejects.toBeInstanceOf(
         SecretStoreError
      );
   });

   test('treats a missing pass entry as a missing secret', async () => {
      if (process.platform !== 'linux') return;
      keytar.getPassword = async () => {
         throw new Error('keychain unavailable');
      };
      execaImplementation = async (command, args, options) => {
         execaCalls.push({ command, args, options });
         return {
            stdout: '',
            stderr: `Error: ${args.at(-1)} is not in the password store.`,
            exitCode: 1,
            failed: true,
         };
      };

      await expect(getSecretStore().getPassword('gdx', 'llm.apiKey')).resolves.toBeNull();
   });

   test('wraps backend failures with guidance and never includes the secret', async () => {
      if (process.platform !== 'linux') return;
      const secret = 'never-print-this-secret';
      keytar.setPassword = async () => {
         throw new Error('keychain unavailable');
      };
      execaImplementation = async () => {
         throw new Error('pass executable was not found');
      };

      try {
         await getSecretStore().setPassword('gdx', 'llm.apiKey', secret);
         throw new Error('Expected setPassword to fail');
      } catch (error) {
         expect(error).toBeInstanceOf(SecretStoreError);
         expect(String(error)).toContain('keytar');
         expect(String(error)).toContain('pass init');
         expect(String(error)).toContain('GDX_LLM_API_KEY');
         expect(String(error)).not.toContain(secret);
      }
   });
});
