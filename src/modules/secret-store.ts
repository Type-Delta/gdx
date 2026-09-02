import { execa } from 'execa';
import crypto from 'crypto';

/** A keytar-compatible store for application secrets. */
export interface SecretStore {
   /** Reads a secret, or null when no backend contains it. */
   getPassword(service: string, account: string): Promise<string | null>;
   /** Writes a secret. */
   setPassword(service: string, account: string, password: string): Promise<void>;
   /** Deletes a secret and reports whether a backend contained it. */
   deletePassword(service: string, account: string): Promise<boolean>;
}

/** Selects the backend used to store secrets. */
export type SecretStoreProvider = 'auto' | 'keychain' | 'pass';

/** A safe summary of one failed secret backend. */
export interface SecretStoreBackendCause {
   backend: 'keytar' | 'pass';
   message: string;
}

type SecretStoreOperation = 'read' | 'write' | 'delete';

/** Reports that no available secret backend could finish an operation. */
export class SecretStoreError extends Error {
   readonly code = 'SECRET_STORE_UNAVAILABLE';

   /**
    * Creates an error containing safe backend summaries and recovery steps.
    * @param operation - The operation that failed.
    * @param backendCauses - Backend errors with secret values removed.
    */
   constructor(
      readonly operation: SecretStoreOperation,
      readonly backendCauses: readonly SecretStoreBackendCause[]
   ) {
      const details = backendCauses
         .map(({ backend, message }) => `${backend}: ${message}`)
         .join('; ');
      const failedBackends = new Set(backendCauses.map(({ backend }) => backend));
      const recoverySteps: string[] = [];
      if (failedBackends.has('keytar')) {
         recoverySteps.push('Repair or unlock the system keychain');
      }
      if (failedBackends.has('pass')) {
         recoverySteps.push(
            'install and initialize pass with `pass init <gpg-id>`; for a locked GPG key, configure terminal pinentry and GPG_TTY or unlock gpg-agent'
         );
      }
      recoverySteps.push('set GDX_LLM_API_KEY for the current environment');
      const guidance = `${recoverySteps.join(', or ')}.`;
      super(`Unable to ${operation} the secret. ${details}. ${guidance}`);
      this.name = 'SecretStoreError';
   }
}

type KeytarModule = typeof import('keytar');

let keytarModulePromise: Promise<KeytarModule> | null = null;
const secretStores = new Map<SecretStoreProvider, SecretStore>();

/** Loads and validates keytar's CommonJS or ESM export. */
async function getKeytar(): Promise<SecretStore> {
   keytarModulePromise ??= import('keytar');
   const module = await keytarModulePromise;
   const candidate = (module as { default?: SecretStore }).default ?? (module as SecretStore);

   if (
      !candidate ||
      typeof candidate.getPassword !== 'function' ||
      typeof candidate.setPassword !== 'function' ||
      typeof candidate.deletePassword !== 'function'
   ) {
      throw new Error('Keytar does not expose the expected password methods.');
   }

   return candidate;
}

/** Hashes an external identifier into one traversal-safe pass path segment. */
function hashPassSegment(value: string): string {
   return crypto.createHash('sha256').update(value).digest('hex');
}

/** Maps keytar's service and account pair to a stable password-store entry. */
function getPassEntry(service: string, account: string): string {
   return `gdx/${hashPassSegment(service)}/${hashPassSegment(account)}`;
}

/** Converts an unknown backend error into a short summary and redacts the written secret. */
function getBackendCause(
   backend: SecretStoreBackendCause['backend'],
   error: unknown,
   secret?: string
): SecretStoreBackendCause {
   let message = error instanceof Error ? error.message : String(error);
   if (secret) message = message.split(secret).join('[redacted]');
   return { backend, message: message || 'Unknown error' };
}

/** Checks whether pass reported a normal absent-entry result. */
function isMissingPassEntry(stderr: string): boolean {
   return /is not in the password store\.?\s*$/i.test(stderr.trim());
}

/** Reads a password-store entry without invoking a shell. */
async function getPassPassword(service: string, account: string): Promise<string | null> {
   const result = await execa('pass', ['show', getPassEntry(service, account)], {
      reject: false,
      stripFinalNewline: false,
   });
   if (result.exitCode === 0) return result.stdout;
   if (isMissingPassEntry(result.stderr)) return null;
   throw new Error(result.stderr.trim() || `pass exited with code ${result.exitCode}.`);
}

/** Writes a password-store entry with the secret supplied only on stdin. */
async function setPassPassword(service: string, account: string, password: string): Promise<void> {
   const result = await execa(
      'pass',
      ['insert', '--multiline', '--force', getPassEntry(service, account)],
      {
         input: password,
         reject: false,
      }
   );
   if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `pass exited with code ${result.exitCode}.`);
   }
}

/** Deletes a password-store entry without invoking a shell. */
async function deletePassPassword(service: string, account: string): Promise<boolean> {
   const result = await execa('pass', ['rm', '--force', getPassEntry(service, account)], {
      reject: false,
   });
   if (result.exitCode === 0) return true;
   if (isMissingPassEntry(result.stderr)) return false;
   throw new Error(result.stderr.trim() || `pass exited with code ${result.exitCode}.`);
}

/** Uses only the native keychain through keytar. */
class KeychainSecretStore implements SecretStore {
   /** Reads a secret from the native keychain. */
   async getPassword(service: string, account: string): Promise<string | null> {
      try {
         return await (await getKeytar()).getPassword(service, account);
      } catch (error) {
         throw new SecretStoreError('read', [getBackendCause('keytar', error)]);
      }
   }

   /** Writes a secret to the native keychain. */
   async setPassword(service: string, account: string, password: string): Promise<void> {
      try {
         await (await getKeytar()).setPassword(service, account, password);
      } catch (error) {
         throw new SecretStoreError('write', [getBackendCause('keytar', error, password)]);
      }
   }

   /** Deletes a secret from the native keychain. */
   async deletePassword(service: string, account: string): Promise<boolean> {
      try {
         return await (await getKeytar()).deletePassword(service, account);
      } catch (error) {
         throw new SecretStoreError('delete', [getBackendCause('keytar', error)]);
      }
   }
}

/** Uses only pass, including on non-Linux platforms where pass is available. */
class PassSecretStore implements SecretStore {
   /** Reads a secret from pass. */
   async getPassword(service: string, account: string): Promise<string | null> {
      try {
         return await getPassPassword(service, account);
      } catch (error) {
         throw new SecretStoreError('read', [getBackendCause('pass', error)]);
      }
   }

   /** Writes a secret to pass. */
   async setPassword(service: string, account: string, password: string): Promise<void> {
      try {
         await setPassPassword(service, account, password);
      } catch (error) {
         throw new SecretStoreError('write', [getBackendCause('pass', error, password)]);
      }
   }

   /** Deletes a secret from pass. */
   async deletePassword(service: string, account: string): Promise<boolean> {
      try {
         return await deletePassPassword(service, account);
      } catch (error) {
         throw new SecretStoreError('delete', [getBackendCause('pass', error)]);
      }
   }
}

/** Combines the native keychain with pass as a Linux fallback. */
class CompositeSecretStore implements SecretStore {
   /** Reads both Linux stores and migrates a fallback value when keytar recovers. */
   async getPassword(service: string, account: string): Promise<string | null> {
      let keytarValue: string | null = null;
      let keytarCause: SecretStoreBackendCause | null = null;
      try {
         keytarValue = await (await getKeytar()).getPassword(service, account);
         if (process.platform !== 'linux') return keytarValue;
      } catch (error) {
         keytarCause = getBackendCause('keytar', error);
         if (process.platform !== 'linux') {
            throw new SecretStoreError('read', [keytarCause]);
         }
      }

      try {
         const passValue = await getPassPassword(service, account);
         if (passValue === null) return keytarValue;

         if (keytarCause === null) {
            try {
               await (await getKeytar()).setPassword(service, account, passValue);
               await deletePassPassword(service, account);
            } catch {
               // The pass value remains authoritative until a later read can reconcile it.
            }
         }
         return passValue;
      } catch (error) {
         if (keytarCause === null) return keytarValue;
         throw new SecretStoreError('read', [keytarCause, getBackendCause('pass', error)]);
      }
   }

   /** Writes to keytar, preserving an existing Linux fallback until reconciliation succeeds. */
   async setPassword(service: string, account: string, password: string): Promise<void> {
      let passPrepared = false;
      if (process.platform === 'linux') {
         try {
            if ((await getPassPassword(service, account)) !== null) {
               await setPassPassword(service, account, password);
               passPrepared = true;
            }
         } catch (error) {
            const passCause = getBackendCause('pass', error, password);
            if (!/ENOENT|not found|could not find command/i.test(passCause.message)) {
               throw new SecretStoreError('write', [passCause]);
            }
         }
      }

      let keytarCause: SecretStoreBackendCause;
      try {
         await (await getKeytar()).setPassword(service, account, password);
         if (passPrepared) {
            try {
               await deletePassPassword(service, account);
            } catch {
               // Both stores contain the new value, so cleanup can wait for a later read.
            }
         }
         return;
      } catch (error) {
         keytarCause = getBackendCause('keytar', error, password);
         if (process.platform !== 'linux') {
            throw new SecretStoreError('write', [keytarCause]);
         }
      }

      if (passPrepared) return;

      try {
         await setPassPassword(service, account, password);
      } catch (error) {
         throw new SecretStoreError('write', [
            keytarCause,
            getBackendCause('pass', error, password),
         ]);
      }
   }

   /** Deletes from both Linux stores so an older fallback entry cannot reappear. */
   async deletePassword(service: string, account: string): Promise<boolean> {
      let keytarDeleted = false;
      let keytarCause: SecretStoreBackendCause | null = null;
      try {
         keytarDeleted = await (await getKeytar()).deletePassword(service, account);
      } catch (error) {
         keytarCause = getBackendCause('keytar', error);
         if (process.platform !== 'linux') {
            throw new SecretStoreError('delete', [keytarCause]);
         }
      }

      if (process.platform !== 'linux') return keytarDeleted;

      try {
         const passDeleted = await deletePassPassword(service, account);
         return keytarDeleted || passDeleted;
      } catch (error) {
         const causes = keytarCause === null
            ? [getBackendCause('pass', error)]
            : [keytarCause, getBackendCause('pass', error)];
         throw new SecretStoreError('delete', causes);
      }
   }
}

/** Returns a process-wide secret store for the selected provider. */
export function getSecretStore(provider: SecretStoreProvider = 'auto'): SecretStore {
   const cached = secretStores.get(provider);
   if (cached) return cached;

   const store = provider === 'keychain'
      ? new KeychainSecretStore()
      : provider === 'pass'
        ? new PassSecretStore()
        : new CompositeSecretStore();
   secretStores.set(provider, store);
   return store;
}
