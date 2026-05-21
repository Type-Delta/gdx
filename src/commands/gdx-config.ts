/* eslint-disable @typescript-eslint/no-explicit-any */
import { strClamp, strWrap, yuString } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { getConfig } from '../common/config';
import { CONFIG_DESCRIPTIONS, DEFAULT_CONFIG } from '../common/config/schema';
import litedent from '@/utils/litedent';
import { progressiveMatch, quickPrint } from '../utils/utilities';
import Logger from '../utils/logger';
import { EXECUTABLE_NAME, SECURE_CONF_KEYS, GDX_VPALETTE, SGR } from '@/consts';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';
import { coerceConfigStringValue } from '@/modules/typebox';

async function listConfig(): Promise<number> {
   const config = await getConfig();

   const flatDefaults = flattenConfig(DEFAULT_CONFIG);
   const currentSection: string[] = [];
   let listStr = '';

   quickPrint(
      SGR.dim +
      `# GDX Configuration\n# read from ${config.getConfigPath()}\n# (api keys stored separately)\n` +
      SGR.reset
   );

   for (const { key } of flatDefaults) {
      const parts = key.split('.');
      const section = parts.slice(0, -1).join('.');
      const fieldName = parts[parts.length - 1];

      // Print section header if changed
      if (!currentSection.includes(section)) {
         if (currentSection.length > 0) {
            listStr += '\n';
         }
         if (section) {
            const sectionDesc = CONFIG_DESCRIPTIONS[section];
            listStr += `${SGR.magenta + SGR.bright}[${section}]${SGR.reset}\n`;
            if (sectionDesc) {
               listStr += `${SGR.dim}# ${sectionDesc.split('\n').join('\n# ')}${SGR.reset}\n`;
            }
         }
         currentSection.push(section);
      }

      let currentValue = config.get(key);
      if (currentValue === undefined && SECURE_CONF_KEYS.includes(key)) {
         currentValue = await config.getSecure(key);
      }

      const isDefault = config.isDefault(key);
      const description = CONFIG_DESCRIPTIONS[key] || '';

      // Format the value for display
      let displayValue: string = '';
      let isUnset = false;

      switch (typeof currentValue) {
         case 'boolean':
            displayValue = yuString(currentValue, { color: true });
            break;
         case 'number':
            displayValue = yuString(currentValue, { color: true });
            break;
         case 'string':
            // Mask API keys
            if (fieldName.toLowerCase().includes('key')) {
               displayValue = yuString(strClamp(currentValue, 20, 'mid', -1), { color: true });
            } else {
               displayValue = yuString(currentValue, { color: true });
            }
            break;
         case 'undefined':
         case 'object':
            if (currentValue == null) {
               isUnset = true;
               displayValue = yuString(null, { color: true });
            }
            break;
         default:
            displayValue = String(currentValue);
      }

      const marker = isDefault
         ? ''
         : ` ${SGR.reset + SGR.yellow + SGR.italic}[Modified]${SGR.reset + SGR.dim}`;
      const comment = description ? ` ${SGR.dim}#${marker} ${description}${SGR.reset}` : '';
      const pairStr = isUnset
         ? `${SGR.dim}# ${SGR.cyan + fieldName + SGR.white} = ${displayValue}${comment}${SGR.reset}\n`
         : `${SGR.cyan + fieldName + SGR.reset} = ${displayValue}${comment}\n`;

      if (currentSection[currentSection.length - 1] === '') listStr = pairStr + '\n' + listStr;
      else listStr += pairStr;
   }

   quickPrint(listStr, '');
   return 0;
}

async function getConfigValue(ctx: GdxContext): Promise<number> {
   const config = await getConfig();
   const key = ctx.args[1];

   if (!key) {
      Logger.error('Missing configuration key', 'gdx-config');
      return 1;
   }

   let value = config.get(key);
   if (value === undefined && SECURE_CONF_KEYS.includes(key)) {
      value = await config.getSecure(key);
   }

   if (value === undefined) {
      Logger.warn(`Key '${key}' is not set`, 'gdx-config');
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
      Logger.error('Usage: gdx gdx-config <key> <value>', 'gdx-config');
      return 1;
   }

   const parsed = coerceConfigStringValue(key, value);
   if (!parsed.ok) {
      Logger.error('Validation failed: ' + parsed.message, 'gdx-config');
      return 1;
   }

   await config.set(key, parsed.value);
   await config.save();

   // Mask API key in output
   const displayValue = key.toLowerCase().includes('key')
      ? strClamp(String(parsed.value), 20, 'mid', -1)
      : parsed.value;

   quickPrint(`${SGR.green}Configuration updated: ${key} = ${displayValue}${SGR.reset}`);
   return 0;
}

export default async function gdxConfig(ctx: GdxContext): Promise<number> {
   const inputCommand = ctx.args[1]?.toLowerCase();
   const { match: subcommand } = progressiveMatch(inputCommand, ['list', 'path']);

   if (subcommand === 'list' || !inputCommand) {
      return await listConfig();
   } else if (subcommand === 'path') {
      const config = await getConfig();
      quickPrint(config.getConfigPath());
      return 0;
   } else if (ctx.args.length === 2) {
      // Get value: gdx gdx-config <key>
      return await getConfigValue(ctx);
   } else if (ctx.args.length === 3) {
      // Set value: gdx gdx-config <key> <value>
      return await setConfigValue(ctx);
   } else {
      quickPrint(
         litedent(
            `${SGR.cyan}Usage:${SGR.reset}
            gdx gdx-config list           - List all configuration
            gdx gdx-config path           - Show config file path
            gdx gdx-config <key>          - Get configuration value
            gdx gdx-config <key> <value>  - Set configuration value`
         )
      );
      return 0;
   }
}

export const help = {
   long: () => {
      return strWrap(
         litedent`
         ${SGR.bright + _2PointGradient('GDX-CONFIG', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         View and modify gdx configuration.

         ${SGR.bright + _2PointGradient('OVERVIEW', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         Manage gdx settings stored in the configuration file. The command supports listing all config values, getting the path to the currently loaded config file, and getting/setting individual keys. API keys and sensitive values are masked when displayed.

         ${SGR.bright + _2PointGradient('COMMANDS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - list: Prints flattened configuration with defaults and modified markers.
         - path: Prints the path to the active config file used by gdx.
         - <key> [value]: Get or set a config key. When setting, types are coerced based on the existing default value where possible.
         `,
         Math.min(100, global.terminalWidth - 4),
         {
            firstIndent: '  ',
            mode: 'softboundary',
            indent: '  ',
         }
      );
   },
   short: 'View or modify gdx configuration settings.',
   usage: () => {
      return strWrap(
         litedent`
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config list${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config path${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config ${SGR.dim}<key> [value]${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} gdx-config list ${SGR.reset + SGR.dim}# List all config keys and values${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} gdx-config editor.code true ${SGR.reset + SGR.dim}# Set value for a key${SGR.reset}
         `,
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
   $root: ['list', 'path'],
} as const satisfies CommandStructure;

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
}
