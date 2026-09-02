/* eslint-disable @typescript-eslint/no-explicit-any */
import path from 'path';
import crypto from 'crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { Err } from '@lib/Tools';

import * as fs from '@/modules/fs';
import {
   DEFAULT_CONFIG,
   ENV_MAPPINGS,
   GdxConfig,
   LOCAL_CONFIG_ALLOWED_KEYS,
   LOCAL_CONFIG_ALLOWED_PREFIXES,
   LOCAL_CONFIG_BLOCKED_KEYS,
} from './schema';
import {
   CONFIG_FILE_NAME,
   CONFIG_PATH,
   CURRENT_DIR,
   KEYCHAIN_SERVICE,
   LEGACY_CONFIG_PATH,
   SECURE_CONF_KEYS,
} from '@/consts';
import Logger from '@/utils/logger';
import {
   coerceConfigStringValue,
   getConfigValueSchema,
   validateConfigValue,
} from '@/modules/typebox';
import { revParseCached } from '@/modules/git';
import {
   getSecretStore,
   type SecretStore,
   type SecretStoreProvider,
} from '@/modules/secret-store';
import { GdxRepositoryLocation } from '@/common/types';

export class ConfigService {
   private configPath: string;
   private config: GdxConfig = structuredClone(DEFAULT_CONFIG);
   private globalConfig: GdxConfig = structuredClone(DEFAULT_CONFIG);
   private envConfig: Partial<GdxConfig> = {};
   private localConfig: Partial<GdxConfig> = {};
   private localConfigPath?: string;
   private localLoaded = false;
   private loaded = false;
   private readonly logger = new Logger('ConfigService');

   constructor(configPath?: string, localConfigPath = resolveLocalConfigPath()) {
      this.configPath = configPath || CONFIG_PATH;
      this.localConfigPath = localConfigPath;
   }

   /**
    * Loads configuration from file and environment variables.
    */
   async load(): Promise<void> {
      if (this.loaded) return;

      // Load from file
      try {
         const fileContent = await fs.readFile(this.configPath, 'utf-8');
         const parsed = parseToml(fileContent);
         this.globalConfig = this.mergeConfig(DEFAULT_CONFIG, parsed as unknown as GdxConfig);
      } catch (e) {
         const err = new Err(e);
         if (err.code !== 'ENOENT') {
            // File exists but couldn't be parsed - not a fatal error
            this.logger.warn(`Failed to parse config file at ${this.configPath}: ${err.message}`);
         }
         // Use defaults if file doesn't exist or can't be parsed
         this.globalConfig = structuredClone(DEFAULT_CONFIG);
      }

      this.config = structuredClone(this.globalConfig);
      this.envConfig = {};
      this.applyEnvOverrides();
      this.loaded = true;
   }

   /**
    * Saves the current configuration to file.
    * Note: Secure keys (like API keys) are not saved to file.
    */
   async save(): Promise<void> {
      // Create a copy without secure keys
      const configToSave = this.removeSecureKeys(this.globalConfig as GdxConfig);
      const tomlString = stringifyToml(configToSave);
      const dirPath = path.dirname(this.configPath);
      if (!fs.existsSync(dirPath)) {
         fs.mkdirSync(dirPath, { recursive: true });
      }
      await fs.writeFile(this.configPath, tomlString, 'utf-8');
   }

   /**
    * Gets a configuration value by path (e.g., 'llm.apiKey').
    */
   get<T = unknown>(keyPath: string, defaultValue: T): T;
   get<T = unknown>(keyPath: string): T | undefined;
   get<T = unknown>(keyPath: string, defaultValue?: T): T | undefined {
      this.applyLocalOverrideForKey(keyPath);
      const keys = keyPath.split('.');
      let value: any = this.config;

      for (const key of keys) {
         if (value && typeof value === 'object' && key in value) {
            value = value[key];
         } else {
            return defaultValue;
         }
      }

      return value as T;
   }

   /**
    * Sets the path used for repository-local config and clears the lazy local cache.
    * @param localConfigPath - Absolute path to `.git/.gdxrc.toml` for the target repo.
    */
   setLocalConfigPath(localConfigPath?: string): void {
      if (this.localConfigPath === localConfigPath) return;
      this.localConfigPath = localConfigPath;
      this.localConfig = {};
      this.localLoaded = false;
      this.rebuildEffectiveConfig();
   }

   /**
    * Gets a secure configuration value by path (e.g., 'llm.apiKey').
    * Loads from secure storage if not already loaded.
    */
   async getSecure<T = unknown>(keyPath: string, defaultValue: T): Promise<T>;
   async getSecure<T = unknown>(keyPath: string): Promise<T | undefined>;
   async getSecure<T = unknown>(keyPath: string, defaultValue?: T): Promise<T | undefined> {
      // First check if it's already loaded (e.g. from env vars or previous fetch)
      const cached = this.get<T>(keyPath);
      if (cached !== undefined) {
         if (this.hasLocalOverride(keyPath) && this.isLocalSecurePointer(keyPath, cached)) {
            const localSecureValue = await this.getLocalSecureValue<T>(keyPath, String(cached));
            return localSecureValue ?? defaultValue;
         }
         return cached;
      }

      // If it's a secure key, try to load it from the configured secret store
      if (SECURE_CONF_KEYS.includes(keyPath)) {
         try {
            const secretStore = this.getConfiguredSecretStore();
            const value = await secretStore.getPassword(KEYCHAIN_SERVICE, keyPath);

            if (value) {
               // Update config cache without triggering a secret-store write
               const keys = keyPath.split('.');
               let target: any = this.config;

               for (let i = 0; i < keys.length - 1; i++) {
                  const key = keys[i];
                  if (!(key in target) || typeof target[key] !== 'object') {
                     target[key] = {};
                  }
                  target = target[key];
               }

               target[keys[keys.length - 1]] = value;
               return value as unknown as T;
            }
         } catch (err) {
            this.logger.warn(
               `Failed to load secure key '${keyPath}' from secret storage:\n` +
               Err.from(err).toString({ color: true })
            );
         }
      }

      return defaultValue;
   }

   /**
    * Sets a configuration value by path (e.g., 'llm.apiKey', 'sk-...')
    * Secure keys are stored outside the config file.
    */
   async set(keyPath: string, value: any): Promise<void> {
      await this.setGlobal(keyPath, value);
   }

   /**
    * Sets a global configuration value by path.
    * @param keyPath - Dot-notation config key.
    * @param value - Parsed config value.
    */
   async setGlobal(keyPath: string, value: any): Promise<void> {
      const validation = validateConfigValue(keyPath, value);
      if (!validation.valid) {
         this.logger.warn(
            `${validation.message ?? `Invalid value for '${keyPath}'.`} Ignoring value.`
         );
         return;
      }

      // If this is a secure key, store it outside the config file
      if (SECURE_CONF_KEYS.includes(keyPath)) {
         const secretStore = this.getConfiguredSecretStore();
         await secretStore.setPassword(KEYCHAIN_SERVICE, keyPath, String(value));
      }

      this.setValueAtPath(this.globalConfig, keyPath, value);
      this.rebuildEffectiveConfig();
   }

   /**
    * Sets a repository-local configuration value by path.
    * @param keyPath - Dot-notation config key.
    * @param value - Parsed config value.
    */
   async setLocal(keyPath: string, value: any): Promise<void> {
      this.assertLocalConfigAllowed(keyPath);
      const validation = validateConfigValue(keyPath, value);
      if (!validation.valid) {
         throw new Err(validation.message ?? `Invalid value for '${keyPath}'.`, 'CONFIG_INVALID');
      }

      this.loadLocalConfig();

      if (SECURE_CONF_KEYS.includes(keyPath)) {
         const account = this.getLocalSecureAccount(keyPath);
         const secretStore = this.getConfiguredSecretStore();
         await secretStore.setPassword(KEYCHAIN_SERVICE, account, String(value));
         this.setValueAtPath(this.localConfig, keyPath, account);
      } else {
         this.setValueAtPath(this.localConfig, keyPath, value);
      }

      this.rebuildEffectiveConfig();
   }

   /**
    * Resets a configuration value by path to its default value.
    * @param keyPath - Dot-notation config key.
    * @returns True when the key is known and was reset.
    */
   async reset(keyPath: string): Promise<boolean> {
      return await this.resetGlobal(keyPath);
   }

   /**
    * Resets a global configuration value by path to its default value.
    * @param keyPath - Dot-notation config key.
    * @returns True when the key is known and was reset.
    */
   async resetGlobal(keyPath: string): Promise<boolean> {
      if (!getConfigValueSchema(keyPath)) {
         return false;
      }

      const keys = keyPath.split('.');
      let defaultValue: any = DEFAULT_CONFIG;
      let target: any = this.globalConfig;

      for (let i = 0; i < keys.length; i++) {
         const key = keys[i];

         if (defaultValue && typeof defaultValue === 'object' && key in defaultValue) {
            defaultValue = defaultValue[key];
         } else {
            defaultValue = undefined;
         }

         if (i < keys.length - 1) {
            if (!(key in target) || typeof target[key] !== 'object') {
               target[key] = {};
            }
            target = target[key];
         }
      }

      if (SECURE_CONF_KEYS.includes(keyPath)) {
         await this.deleteSecureKey(keyPath);
      }

      target[keys[keys.length - 1]] = structuredClone(defaultValue);
      this.rebuildEffectiveConfig();
      return true;
   }

   /**
    * Removes a repository-local override by path.
    * @param keyPath - Dot-notation config key.
    * @returns True when the key can be configured locally.
    */
   async resetLocal(keyPath: string): Promise<boolean> {
      this.assertLocalConfigAllowed(keyPath);
      if (!getConfigValueSchema(keyPath)) return false;

      this.loadLocalConfig();
      const localValue = this.getValueAtPath(this.localConfig, keyPath);
      if (SECURE_CONF_KEYS.includes(keyPath) && typeof localValue === 'string') {
         await this.deleteLocalSecureKey(localValue);
      }

      this.deleteValueAtPath(this.localConfig, keyPath);
      this.rebuildEffectiveConfig();
      return true;
   }

   /** Saves sparse repository-local config to `.git/.gdxrc.toml`. */
   async saveLocal(): Promise<void> {
      this.loadLocalConfig();
      const localConfigPath = this.getLocalConfigPath();
      const tomlString = stringifyToml(this.localConfig);
      const dirPath = path.dirname(localConfigPath);
      if (!fs.existsSync(dirPath)) {
         fs.mkdirSync(dirPath, { recursive: true });
      }
      await fs.writeFile(localConfigPath, tomlString, 'utf-8');
   }

   /**
    * Gets the entire configuration object.
    */
   getAll(): Readonly<GdxConfig> {
      this.loadLocalConfig();
      this.rebuildEffectiveConfig();
      return this.config;
   }

   /**
    * Gets the config file path.
    */
   getConfigPath(): string {
      return this.configPath;
   }

   /** Gets the repository-local config file path. */
   getLocalConfigPath(): string {
      if (!this.localConfigPath) {
         throw new Err('Local config is only available inside a git repository.', 'CONFIG_LOCAL_UNAVAILABLE');
      }
      return this.localConfigPath;
   }

   /**
    * Checks if a value is using the default (not set in config file).
    */
   isDefault(keyPath: string): boolean {
      this.applyLocalOverrideForKey(keyPath);
      const keys = keyPath.split('.');
      let value: any = this.config;
      let defaultValue: any = DEFAULT_CONFIG;

      for (const key of keys) {
         if (value && typeof value === 'object' && key in value) {
            value = value[key];
         } else {
            value = undefined;
         }

         if (defaultValue && typeof defaultValue === 'object' && key in defaultValue) {
            defaultValue = defaultValue[key];
         } else {
            defaultValue = undefined;
         }
      }

      // If value equals default, it's using default
      return value === defaultValue;
   }

   /** Checks if a key is explicitly overridden by repository-local config. */
   isLocalOverride(keyPath: string): boolean {
      this.applyLocalOverrideForKey(keyPath);
      return this.hasLocalOverride(keyPath);
   }

   /** Checks if a key may be written to repository-local config. */
   canSetLocal(keyPath: string): boolean {
      return isLocalConfigAllowed(keyPath);
   }

   /**
    * Merges two config objects, validating types.
    */
   private mergeConfig(base: GdxConfig, override: GdxConfig): GdxConfig {
      const result: GdxConfig = structuredClone(base);

      const merge = (
         target: Record<string, unknown>,
         source: Record<string, unknown>,
         path: string = ''
      ) => {
         for (const key in source) {
            const currentPath = path ? `${path}.${key}` : key;
            const sourceValue = source[key];
            const targetValue = target[key];
            const valueSchema = getConfigValueSchema(currentPath);

            if (!valueSchema) {
               // Unknown key - silently ignore
               continue;
            }

            if (
               typeof sourceValue === 'object' &&
               sourceValue !== null &&
               !Array.isArray(sourceValue)
            ) {
               if (typeof targetValue === 'object' && targetValue !== null) {
                  merge(
                     target[key] as Record<string, unknown>,
                     sourceValue as Record<string, unknown>,
                     currentPath
                  );
               } else {
                  this.logger.warn(
                     `Type mismatch for '${currentPath}'. Expected ${typeof targetValue}, got object. Ignoring value.`
                  );
               }
            } else {
               const validation = validateConfigValue(currentPath, sourceValue);
               if (validation.valid) {
                  target[key] = sourceValue;
               } else {
                  this.logger.warn(
                     `${validation.message ?? `Invalid value for '${currentPath}'.`} Ignoring value.`
                  );
               }
            }
         }
      };

      merge(
         result as unknown as Record<string, unknown>,
         override as unknown as Record<string, unknown>
      );
      return result;
   }

   private mergePartialConfig(base: GdxConfig, override: Partial<GdxConfig>): GdxConfig {
      return this.mergeConfig(base, override as GdxConfig);
   }

   /**
    * Removes secure keys from a config object.
    */
   private removeSecureKeys(config: GdxConfig): GdxConfig {
      const result = structuredClone(config);

      for (const keyPath of SECURE_CONF_KEYS) {
         const keys = keyPath.split('.');
         let target: any = result;

         for (let i = 0; i < keys.length - 1; i++) {
            if (!target[keys[i]]) return result;
            target = target[keys[i]];
         }

         delete target[keys[keys.length - 1]];
      }

      return result;
   }

   /**
    * Deletes a secure key from secret storage.
    */
   async deleteSecureKey(keyPath: string): Promise<boolean> {
      if (!SECURE_CONF_KEYS.includes(keyPath)) return false;

      const secretStore = this.getConfiguredSecretStore();
      return await secretStore.deletePassword(KEYCHAIN_SERVICE, keyPath);
   }

   /**
    * Applies environment variable overrides.
    */
   private applyEnvOverrides(): void {
      for (const [keyPath, envVar] of Object.entries(ENV_MAPPINGS)) {
         const envValue = process.env[envVar];
         if (envValue !== undefined) {
            const parsed = coerceConfigStringValue(keyPath, envValue);
            if (!parsed.ok) {
               this.logger.warn(`Environment variable ${envVar}: ${parsed.message}. Ignoring.`);
               continue;
            }

            this.setValueAtPath(this.envConfig, keyPath, parsed.value);
         }
      }
      this.rebuildEffectiveConfig();
   }

   private applyLocalOverrideForKey(keyPath: string): void {
      if (!isLocalConfigAllowed(keyPath)) return;
      this.loadLocalConfig();
      this.rebuildEffectiveConfig();
   }

   private loadLocalConfig(): void {
      if (this.localLoaded) return;
      this.localLoaded = true;
      if (!this.localConfigPath || !fs.existsSync(this.localConfigPath)) {
         this.localConfig = {};
         return;
      }

      try {
         const fileContent = fs.readFileSync(this.localConfigPath, 'utf-8');
         const parsed = parseToml(fileContent);
         this.localConfig = this.filterLocalConfig(parsed as Record<string, unknown>) as Partial<GdxConfig>;
      } catch (e) {
         this.localConfig = {};
         this.logger.warn(
            `Failed to parse local config file at ${this.localConfigPath}: ${Err.from(e).message}`
         );
      }
   }

   private rebuildEffectiveConfig(): void {
      const withLocal = this.mergePartialConfig(this.globalConfig, this.localConfig);
      this.config = this.mergePartialConfig(withLocal, this.envConfig);
   }

   private filterLocalConfig(config: Record<string, unknown>): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      const walk = (source: Record<string, unknown>, target: Record<string, unknown>, prefix = '') => {
         for (const [key, value] of Object.entries(source)) {
            const currentPath = prefix ? `${prefix}.${key}` : key;
            if (value && typeof value === 'object' && !Array.isArray(value)) {
               const nextTarget: Record<string, unknown> = {};
               walk(value as Record<string, unknown>, nextTarget, currentPath);
               if (Object.keys(nextTarget).length > 0) target[key] = nextTarget;
               continue;
            }

            if (!isLocalConfigAllowed(currentPath)) {
               this.logger.warn(`Ignoring local-only unsupported config key '${currentPath}'.`);
               continue;
            }

            const validation = validateConfigValue(currentPath, value);
            if (validation.valid) target[key] = value;
            else this.logger.warn(`${validation.message ?? `Invalid value for '${currentPath}'.`} Ignoring value.`);
         }
      };

      walk(config, result);
      return result;
   }

   private assertLocalConfigAllowed(keyPath: string): void {
      if (!isLocalConfigAllowed(keyPath)) {
         throw new Err(`Configuration key '${keyPath}' cannot be set locally.`, 'CONFIG_LOCAL_UNSUPPORTED');
      }
      this.getLocalConfigPath();
   }

   private getLocalSecureAccount(keyPath: string): string {
      const projectKey = crypto
         .createHash('sha256')
         .update(path.resolve(path.dirname(this.getLocalConfigPath())))
         .digest('hex')
         .slice(0, 16);
      return `local:${projectKey}:${keyPath}`;
   }

   private isLocalSecurePointer(keyPath: string, value: unknown): boolean {
      return SECURE_CONF_KEYS.includes(keyPath) && typeof value === 'string' && value.startsWith('local:');
   }

   private async getLocalSecureValue<T>(keyPath: string, account: string): Promise<T | undefined> {
      try {
         const secretStore = this.getConfiguredSecretStore();
         const value = await secretStore.getPassword(KEYCHAIN_SERVICE, account);
         return value === null ? undefined : (value as unknown as T);
      } catch (err) {
         this.logger.warn(
            `Failed to load local secure key '${keyPath}' from secret storage:\n` +
            Err.from(err).toString({ color: true })
         );
         return undefined;
      }
   }

   private async deleteLocalSecureKey(account: string): Promise<boolean> {
      const secretStore = this.getConfiguredSecretStore();
      return await secretStore.deletePassword(KEYCHAIN_SERVICE, account);
   }

   /** Loads the secret backend selected by the effective global configuration. */
   private getConfiguredSecretStore(): SecretStore {
      const provider = this.get<SecretStoreProvider>('security.secretStore', 'auto');
      return getSecretStore(provider);
   }

   private hasLocalOverride(keyPath: string): boolean {
      return this.getValueAtPath(this.localConfig, keyPath) !== undefined;
   }

   private getValueAtPath(config: unknown, keyPath: string): unknown {
      const keys = keyPath.split('.');
      let value: any = config;
      for (const key of keys) {
         if (value && typeof value === 'object' && key in value) value = value[key];
         else return undefined;
      }
      return value;
   }

   private setValueAtPath(config: unknown, keyPath: string, value: unknown): void {
      const keys = keyPath.split('.');
      let target: any = config;
      for (let i = 0; i < keys.length - 1; i++) {
         const key = keys[i];
         if (!(key in target) || typeof target[key] !== 'object' || target[key] === null) target[key] = {};
         target = target[key];
      }
      target[keys[keys.length - 1]] = value;
   }

   private deleteValueAtPath(config: unknown, keyPath: string): void {
      const keys = keyPath.split('.');
      let target: any = config;
      for (let i = 0; i < keys.length - 1; i++) {
         const key = keys[i];
         if (!target || typeof target !== 'object' || !(key in target)) return;
         target = target[key];
      }
      if (target && typeof target === 'object') delete target[keys[keys.length - 1]];
   }
}

export function isLocalConfigAllowed(keyPath: string): boolean {
   if ((LOCAL_CONFIG_BLOCKED_KEYS as readonly string[]).includes(keyPath)) return false;
   if ((LOCAL_CONFIG_ALLOWED_KEYS as readonly string[]).includes(keyPath)) return true;
   return LOCAL_CONFIG_ALLOWED_PREFIXES.some((prefix) => keyPath.startsWith(prefix));
}

// Singleton instance
let instance: ConfigService | null = null;

function resolveConfigPath(): string {
   const envPath = process.env.GDX_CONFIG_PATH;
   if (envPath) {
      return envPath;
   }

   if (fs.existsSync(CONFIG_PATH)) {
      return CONFIG_PATH;
   }

   if (fs.existsSync(LEGACY_CONFIG_PATH)) {
      return LEGACY_CONFIG_PATH;
   }

   return CONFIG_PATH;
}

function resolveLocalConfigPath(currentDir = CURRENT_DIR): string | undefined {
   const gitPath = path.join(currentDir, '.git');
   if (fs.existsSync(gitPath)) {
      try {
         const stat = fs.statSync(gitPath);
         if (stat.isDirectory()) return path.join(gitPath, CONFIG_FILE_NAME);
         if (stat.isFile()) {
            const content = fs.readFileSync(gitPath, 'utf-8');
            const match = /^gitdir:\s*(.+)$/m.exec(content);
            if (match) {
               const gitDir = path.isAbsolute(match[1])
                  ? match[1]
                  : path.resolve(currentDir, match[1]);
               return path.join(gitDir, CONFIG_FILE_NAME);
            }
         }
      } catch {
         return undefined;
      }
   }

   return undefined;
}

export async function resolveLocalConfigPathFromGit(git$: string | string[]): Promise<string | undefined> {
   const repository = await resolveRepositoryLocationFromGit(git$);
   if (repository) return path.join(repository.gitDir, CONFIG_FILE_NAME);

   if (!Array.isArray(git$)) return resolveLocalConfigPath();
   const cwdFlagIndex = git$.indexOf('-C');
   const currentDir = cwdFlagIndex >= 0 ? git$[cwdFlagIndex + 1] : CURRENT_DIR;
   return currentDir ? resolveLocalConfigPath(currentDir) : undefined;
}

/** Resolves reusable repository paths with the same startup Git call used for local config. */
export async function resolveRepositoryLocationFromGit(
   git$: string | string[]
): Promise<GdxRepositoryLocation | undefined> {
   try {
      const output = (
         await revParseCached(git$, [
            '--path-format=absolute',
            '--show-toplevel',
            '--git-common-dir',
            '--git-dir',
         ])
      )
         .split(/\r?\n/)
         .filter(Boolean);
      if (output.length === 3) {
         const [root, commonGitDir, gitDir] = output;
         return {
            root: path.resolve(root),
            commonGitDir: path.resolve(commonGitDir),
            gitDir: path.resolve(gitDir),
         };
      }
   } catch {
      return undefined;
   }
   return undefined;
}

/**
 * Gets the singleton ConfigService instance.
 */
export async function getConfig(): Promise<ConfigService> {
   if (!instance) {
      instance = new ConfigService(resolveConfigPath());
      await instance.load();
   }
   return instance;
}

/**
 * Resets the singleton instance (useful for testing).
 */
export function resetConfig(): void {
   instance = null;
}
