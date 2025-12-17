import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import * as keytar from 'keytar';

import { GdxConfig, DEFAULT_CONFIG, ENV_MAPPINGS } from './schema';
import { KEYCHAIN_SERVICE, SECURE_CONF_KEYS } from '@/consts';


export class ConfigService {
   private configPath: string;
   private config: GdxConfig = { ...DEFAULT_CONFIG };
   private loaded = false;

   constructor(configPath?: string) {
      this.configPath = configPath || path.join(os.homedir(), '.gdxrc.toml');
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
         this.config = this.mergeConfig(DEFAULT_CONFIG, parsed as GdxConfig);
      } catch (err: any) {
         if (err.code !== 'ENOENT') {
            // File exists but couldn't be parsed - not a fatal error
            console.warn(`Warning: Failed to parse config file at ${this.configPath}: ${err.message}`);
         }
         // Use defaults if file doesn't exist or can't be parsed
         this.config = { ...DEFAULT_CONFIG };
      }

      // Load secure keys from keychain
      await this.loadSecureKeys();

      // Override with environment variables
      this.applyEnvOverrides();
      this.loaded = true;
   }

   /**
    * Saves the current configuration to file.
    * Note: Secure keys (like API keys) are not saved to file.
    */
   async save(): Promise<void> {
      // Create a copy without secure keys
      const configToSave = this.removeSecureKeys(this.config);
      const tomlString = stringifyToml(configToSave);
      await fs.writeFile(this.configPath, tomlString, 'utf-8');
   }

   /**
    * Gets a configuration value by path (e.g., 'llm.apiKey').
    */
   get<T = any>(keyPath: string): T | undefined {
      const keys = keyPath.split('.');
      let value: any = this.config;

      for (const key of keys) {
         if (value && typeof value === 'object' && key in value) {
            value = value[key];
         } else {
            return undefined;
         }
      }

      return value as T;
   }

   /**
    * Sets a configuration value by path (e.g., 'llm.apiKey', 'sk-...')
    * Secure keys are stored in the system keychain instead of the config file.
    */
   async set(keyPath: string, value: any): Promise<void> {
      const keys = keyPath.split('.');
      let target: any = this.config;

      for (let i = 0; i < keys.length - 1; i++) {
         const key = keys[i];
         if (!(key in target) || typeof target[key] !== 'object') {
            target[key] = {};
         }
         target = target[key];
      }

      const lastKey = keys[keys.length - 1];

      // Validate type against default config
      const defaultValue = this.get(keyPath);
      if (defaultValue !== undefined && typeof value !== typeof defaultValue) {
         console.warn(
            `Warning: Type mismatch for '${keyPath}'. Expected ${typeof defaultValue}, got ${typeof value}. Ignoring value.`
         );
         return;
      }

      // If this is a secure key, store it in keychain
      if (SECURE_CONF_KEYS.includes(keyPath)) {
         await keytar.setPassword(KEYCHAIN_SERVICE, keyPath, String(value));
      }

      target[lastKey] = value;
   }

   /**
    * Gets the entire configuration object.
    */
   getAll(): Readonly<GdxConfig> {
      return this.config;
   }

   /**
    * Gets the config file path.
    */
   getConfigPath(): string {
      return this.configPath;
   }

   /**
    * Checks if a value is using the default (not set in config file).
    */
   isDefault(keyPath: string): boolean {
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

   /**
    * Merges two config objects, validating types.
    */
   private mergeConfig(base: GdxConfig, override: GdxConfig): GdxConfig {
      const result: GdxConfig = structuredClone(base);

      const merge = (target: Record<string, unknown>, source: Record<string, unknown>, path: string = '') => {
         for (const key in source) {
            const currentPath = path ? `${path}.${key}` : key;
            const sourceValue = source[key];
            const targetValue = target[key];

            if (targetValue === undefined) {
               // Unknown key - silently ignore
               continue;
            }

            if (typeof sourceValue === 'object' && sourceValue !== null && !Array.isArray(sourceValue)) {
               if (typeof targetValue === 'object' && targetValue !== null) {
                  merge(
                     target[key] as Record<string, unknown>,
                     sourceValue as Record<string, unknown>,
                     currentPath
                  );
               } else {
                  console.warn(
                     `Warning: Type mismatch for '${currentPath}'. Expected ${typeof targetValue}, got object. Ignoring value.`
                  );
               }
            } else {
               if (typeof sourceValue !== typeof targetValue) {
                  console.warn(
                     `Warning: Type mismatch for '${currentPath}'. Expected ${typeof targetValue}, got ${typeof sourceValue}. Ignoring value.`
                  );
               } else {
                  target[key] = sourceValue;
               }
            }
         }
      };

      merge(result as Record<string, unknown>, override as Record<string, unknown>);
      return result;
   }

   /**
    * Loads secure keys from system keychain.
    */
   private async loadSecureKeys(): Promise<void> {
      for (const keyPath of SECURE_CONF_KEYS) {
         try {
            const value = await keytar.getPassword(KEYCHAIN_SERVICE, keyPath);
            if (value) {
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
            }
         }
         catch (err) {
            console.warn(`Warning: Failed to load secure key '${keyPath}' from keychain:`, err);
         }
      }
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
    * Deletes a secure key from the keychain.
    */
   async deleteSecureKey(keyPath: string): Promise<boolean> {
      if (!SECURE_CONF_KEYS.includes(keyPath)) return false;

      try {
         return await keytar.deletePassword(KEYCHAIN_SERVICE, keyPath);
      } catch {
         return false;
      }
   }

   /**
    * Applies environment variable overrides.
    */
   private applyEnvOverrides(): void {
      for (const [keyPath, envVar] of Object.entries(ENV_MAPPINGS)) {
         const envValue = process.env[envVar];
         if (envValue !== undefined) {
            const defaultValue = this.get(keyPath);
            let parsedValue: any = envValue;

            // Try to parse based on expected type
            if (typeof defaultValue === 'number') {
               const num = Number(envValue);
               if (!isNaN(num)) {
                  parsedValue = num;
               } else {
                  console.warn(
                     `Warning: Environment variable ${envVar} has invalid number value '${envValue}'. Ignoring.`
                  );
                  continue;
               }
            } else if (typeof defaultValue === 'boolean') {
               parsedValue = envValue.toLowerCase() === 'true';
            }

            this.set(keyPath, parsedValue);
         }
      }
   }
}

// Singleton instance
let instance: ConfigService | null = null;

/**
 * Gets the singleton ConfigService instance.
 */
export async function getConfig(): Promise<ConfigService> {
   if (!instance) {
      instance = new ConfigService();
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
