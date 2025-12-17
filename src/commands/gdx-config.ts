import { GdxContext } from '../common/types';
import { getConfig } from '../common/config';
import { CONFIG_DESCRIPTIONS, DEFAULT_CONFIG } from '../common/config/schema';
import { quickPrint } from '../utils/utilities';
import { ncc, strClamp } from '@lib/Tools';

async function listConfig(): Promise<number> {
   const config = await getConfig();

   const flatDefaults = flattenConfig(DEFAULT_CONFIG);
   const currentSection: string[] = [];

   quickPrint(ncc('Dim') + `# GDX Configuration\n# read from ${config.getConfigPath()}\n# (api keys stored separately)\n` + ncc());

   for (const { key } of flatDefaults) {
      const parts = key.split('.');
      const section = parts.slice(0, -1).join('.');
      const fieldName = parts[parts.length - 1];

      // Print section header if changed
      if (!currentSection.includes(section)) {
         if (currentSection.length > 0) {
            quickPrint(''); // Empty line between sections
         }
         quickPrint(`${ncc('Magenta') + ncc('Bright')}[${section}]${ncc()}`);
         currentSection.push(section);
      }

      const currentValue = config.get(key);
      const isDefault = config.isDefault(key);
      const description = CONFIG_DESCRIPTIONS[key] || '';

      // Format the value for display
      let displayValue: string;
      let isUnset = false;

      if (currentValue == null) {
         displayValue = 'null';
         isUnset = true;
      } else if (typeof currentValue === 'string') {
         // Mask API keys
         if (fieldName.toLowerCase().includes('key')) {
            displayValue = `"${strClamp(currentValue, 20, 'mid', -1)}"`;
         } else {
            displayValue = `"${currentValue}"`;
         }
      } else {
         displayValue = String(currentValue);
      }

      const marker = isDefault ? '' : ` ${ncc() + ncc('Yellow') + ncc('Italic')}[Modified]${ncc() + ncc('Dim')}`;
      const comment = description ? ` ${ncc('Dim')}#${marker} ${description}${ncc()}` : '';

      if (isUnset) {
         // Show unset values as comments
         quickPrint(`${ncc('Dim')}# ${ncc('Cyan') + fieldName + ncc('White')} = ${displayValue}${comment}${ncc()}`);
      } else {
         quickPrint(`${ncc('Dim') + ncc('Cyan') + fieldName + ncc()} = ${displayValue}${comment}`);
      }
   }

   return 0;
}

async function getConfigValue(ctx: GdxContext): Promise<number> {
   const config = await getConfig();
   const key = ctx.args[1];

   if (!key) {
      quickPrint(`${ncc('Red')}Error: Missing configuration key${ncc()}`);
      return 1;
   }

   const value = config.get(key);

   if (value === undefined) {
      quickPrint(`${ncc('Yellow')}Key '${key}' is not set${ncc()}`);
      return 1;
   }

   quickPrint(String(value));
   return 0;
}

async function setConfigValue(ctx: GdxContext): Promise<number> {
   const config = await getConfig();
   const key = ctx.args[1];
   const value = ctx.args[2];

   if (!key || value === undefined) {
      quickPrint(`${ncc('Red')}Error: Usage: gdx gdx-config <key> <value>${ncc()}`);
      return 1;
   }

   // Try to parse value based on expected type
   const defaultValue = config.get(key);
   let parsedValue: any = value;

   if (typeof defaultValue === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
         quickPrint(`${ncc('Red')}Error: Expected a number for '${key}', got '${value}'${ncc()}`);
         return 1;
      }
      parsedValue = num;
   }
   else if (typeof defaultValue === 'boolean') {
      parsedValue = value.toLowerCase() === 'true';
   }

   await config.set(key, parsedValue);
   await config.save();

   // Mask API key in output
   const displayValue = key.toLowerCase().includes('key')
      ? strClamp(String(parsedValue), 20, 'mid', -1)
      : parsedValue;

   quickPrint(`${ncc('Green')}Configuration updated: ${key} = ${displayValue}${ncc()}`);
   return 0;
}

export default async function gdxConfig(ctx: GdxContext): Promise<number> {
   const subcommand = ctx.args[1];

   if (subcommand === 'list') {
      return await listConfig();
   }
   else if (subcommand === 'path') {
      const config = await getConfig();
      quickPrint(config.getConfigPath());
      return 0;
   }
   else if (ctx.args.length === 2) {
      // Get value: gdx gdx-config <key>
      return await getConfigValue(ctx);
   } else if (ctx.args.length === 3) {
      // Set value: gdx gdx-config <key> <value>
      return await setConfigValue(ctx);
   } else {
      quickPrint(`${ncc('Cyan')}Usage:${ncc()}`);
      quickPrint(`  gdx gdx-config list           - List all configuration`);
      quickPrint(`  gdx gdx-config path           - Show config file path`);
      quickPrint(`  gdx gdx-config <key>          - Get configuration value`);
      quickPrint(`  gdx gdx-config <key> <value>  - Set configuration value`);
      return 0;
   }
}

/**
 * Flatten the config object to get all keys
 */
function flattenConfig(obj: any, prefix = ''): Array<{ key: string; value: any }> {
   const result: Array<{ key: string; value: any }> = [];

   for (const key in obj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const value = obj[key];

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
         result.push(...flattenConfig(value, fullKey));
      } else {
         result.push({ key: fullKey, value });
      }
   }

   return result;
};
