/* eslint-disable @typescript-eslint/no-explicit-any */
import litedent from 'litedent';

import { Err, strClamp, strWrap, yuString } from '@lib/Tools';

import { CommandHelpObj, CommandStructure, GdxContext } from '../common/types';
import { getConfig, resolveLocalConfigPathFromGit } from '../common/config';
import { CONFIG_DESCRIPTIONS, DEFAULT_CONFIG } from '../common/config/schema';
import { progressiveMatch, quickPrint } from '../utils/utilities';
import Logger from '../utils/logger';
import { EXECUTABLE_NAME, SECURE_CONF_KEYS, GDX_VPALETTE, SGR } from '@/consts';
import global from '@/global';
import { _2PointGradient } from '@/modules/graphics';
import { coerceConfigStringValue } from '@/modules/typebox';
import { ArgsSet } from '@/modules/arguments';

async function listConfig(): Promise<number> {
   const config = await getConfig();

   const flatDefaults = flattenConfig(DEFAULT_CONFIG);
   const currentSection: string[] = [];
   const noSection: string[] = [];
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
      if (SECURE_CONF_KEYS.includes(key)) {
         currentValue = await config.getSecure(key);
      }

      const isDefault = config.isDefault(key);
      const isLocalOverride = config.isLocalOverride(key);
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

      const localMarker = isLocalOverride
         ? ` ${SGR.reset + SGR.magenta + SGR.italic}[LO]${SGR.reset + SGR.dim}`
         : '';
      const modifiedMarker = isDefault
         ? ''
         : ` ${SGR.reset + SGR.yellow + SGR.italic}[Modified]${SGR.reset + SGR.dim}`;
      const marker = localMarker + modifiedMarker;
      const comment = description ? ` ${SGR.dim}#${marker} ${description}${SGR.reset}` : '';
      const pairStr = isUnset
         ? `${SGR.dim}# ${SGR.cyan + fieldName + SGR.white} = ${displayValue}${comment}${SGR.reset}\n`
         : `${SGR.cyan + fieldName + SGR.reset} = ${displayValue}${comment}\n`;

      if (currentSection[currentSection.length - 1] === '') noSection.push(pairStr);
      else listStr += pairStr;
   }

   quickPrint((noSection.length ? noSection.join('') + '\n' : '') + listStr, '');
   return 0;
}

async function getConfigValue(ctx: GdxContext): Promise<number> {
   const config = await getConfig();
   const args = ctx.args.slice(1);
   popLocalOption(args);
   const reveal = args.popOption('--reveal') !== null;
   const key = args[0];

   if (!key || args.length !== 1) {
      Logger.error('Missing configuration key', 'gdx-config');
      return 1;
   }

   let value = config.get(key);
   if (SECURE_CONF_KEYS.includes(key)) {
      value = await config.getSecure(key);
   }

   if (value === undefined) {
      Logger.warn(`Key '${key}' is not set`, 'gdx-config');
      return 1;
   }

   if (SECURE_CONF_KEYS.includes(key) && !reveal) {
      quickPrint(strClamp(String(value), 20, 'mid', -1));
   } else {
      quickPrint(String(value));
   }
   return 0;
}

async function setConfigValue(ctx: GdxContext): Promise<number> {
   const config = await getConfig();
   const args = ctx.args.slice(1);
   const isLocal = popLocalOption(args);
   const key = args[0];
   const value = args[1];

   if (!key || value === undefined || args.length !== 2) {
      Logger.error('Usage: gdx gdx-config [--local] <key> <value>', 'gdx-config');
      return 1;
   }

   const parsed = coerceConfigStringValue(key, value);
   if (!parsed.ok) {
      Logger.error('Validation failed: ' + parsed.message, 'gdx-config');
      return 1;
   }

   if (isLocal) {
      if (!config.canSetLocal(key)) {
         Logger.error(`Configuration key '${key}' cannot be set locally.`, 'gdx-config');
         return 1;
      }

      try {
         await config.setLocal(key, parsed.value);
      } catch (err) {
         Logger.error(Err.from(err).message, 'gdx-config');
         return 1;
      }
      await config.saveLocal();
   } else {
      await config.set(key, parsed.value);
      await config.save();
   }

   // Mask API key in output
   const displayValue = key.toLowerCase().includes('key')
      ? strClamp(String(parsed.value), 20, 'mid', -1)
      : parsed.value;

   quickPrint(
      `${SGR.green}${isLocal ? 'Local c' : 'C'}onfiguration updated: ${key} = ${displayValue}${SGR.reset}`
   );
   return 0;
}

async function unsetConfigValue(ctx: GdxContext): Promise<number> {
   const config = await getConfig();
   const args = ctx.args.slice(1);
   const isLocal = popLocalOption(args);
   args.popOption('--unset');
   args.popOption('-u');
   const key = args[0];

   if (!key || args.length !== 1) {
      Logger.error('Usage: gdx gdx-config [--local] --unset <key>', 'gdx-config');
      return 1;
   }

   if (isLocal && !config.canSetLocal(key)) {
      Logger.error(`Configuration key '${key}' cannot be set locally.`, 'gdx-config');
      return 1;
   }

   let didReset: boolean;
   try {
      didReset = isLocal ? await config.resetLocal(key) : await config.reset(key);
   } catch (err) {
      Logger.error(Err.from(err).message, 'gdx-config');
      return 1;
   }
   if (!didReset) {
      Logger.error(`Unknown configuration key '${key}'.`, 'gdx-config');
      return 1;
   }

   if (isLocal) await config.saveLocal();
   else await config.save();

   const defaultValue = config.get(key);
   const displayValue = key.toLowerCase().includes('key')
      ? strClamp(String(defaultValue), 20, 'mid', -1)
      : defaultValue;

   quickPrint(
      `${SGR.green}${isLocal ? 'Local configuration unset' : 'Configuration reset to default'}: ${key} = ${displayValue}${SGR.reset}`
   );
   return 0;
}

export default async function gdxConfig(ctx: GdxContext): Promise<number> {
   const config = await getConfig();
   config.setLocalConfigPath(await resolveLocalConfigPathFromGit(ctx.git$));

   const normalizedArgs = ctx.args.slice(0);
   popLocalOption(normalizedArgs);
   const inputCommand = normalizedArgs[1]?.toLowerCase();
   const normalizedCommand = inputCommand === 'ls' ? 'list' : inputCommand;
   const { match: subcommand } = progressiveMatch(normalizedCommand, ['list', 'path']);
   const hasUnset = ctx.args.hasOption('--unset', 1) || ctx.args.hasOption('-u', 1);

   if (hasUnset) {
      return await unsetConfigValue(ctx);
   } else if (subcommand === 'list' || !inputCommand) {
      return await listConfig();
   } else if (subcommand === 'path') {
      const isLocal = ctx.args.hasOption('--local', 1) || ctx.args.hasOption('-l', 1);
      try {
         quickPrint(isLocal ? config.getLocalConfigPath() : config.getConfigPath());
      } catch (err) {
         Logger.error(Err.from(err).message, 'gdx-config');
         return 1;
      }
      return 0;
   } else if (normalizedArgs.length === 2) {
      // Get value: gdx gdx-config <key>
      return await getConfigValue(ctx);
   } else if (normalizedArgs.length === 3) {
      // Set value: gdx gdx-config <key> <value>
      return await setConfigValue(ctx);
   } else {
      quickPrint(
         litedent(
            `${SGR.cyan}Usage:${SGR.reset}
            gdx gdx-config [list]         - List all configuration
            gdx gdx-config path           - Show config file path
            gdx gdx-config <key>          - Get configuration value
            gdx gdx-config [--local] <key> <value>  - Set configuration value
            gdx gdx-config --unset <key>  - Reset configuration value to default`
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
         Manage gdx settings stored in the configuration file. The command supports listing all config values, getting the path to the currently loaded config file, and getting, setting, or resetting individual keys. API keys and sensitive values are masked when displayed.

         ${SGR.bright + _2PointGradient('COMMANDS', GDX_VPALETTE.Zinc400, GDX_VPALETTE.Zinc100, 0.2) + SGR.reset}
         - list: Prints flattened configuration with defaults and modified markers.
         - path: Prints the path to the active config file used by gdx. Pass --local to print the repository-local config path.
         - <key> [value]: Get or set a config key. Pass --local when setting to write a repository-local override.
         - --unset, -u <key>: Reset a config key to its default value.
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
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config [list]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config path ${SGR.dim}[--local]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config ${SGR.dim}<key> [value]${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config --local ${SGR.dim}<key> <value>${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config --unset ${SGR.dim}<key>${SGR.reset}
         ${SGR.cyan}${EXECUTABLE_NAME} gdx-config -u ${SGR.dim}<key>${SGR.reset}

         Examples:
            ${SGR.cyan}${EXECUTABLE_NAME} gdx-config ${SGR.reset + SGR.dim}# List all config keys and values${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} gdx-config defaultEditor code ${SGR.reset + SGR.dim}# Set value for a key${SGR.reset}
            ${SGR.cyan}${EXECUTABLE_NAME} gdx-config --unset defaultEditor ${SGR.reset + SGR.dim}# Reset a key to default${SGR.reset}
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
   $root: ['list', 'ls', 'path', '--unset', '-u', '--local', '-l'],
} as const satisfies CommandStructure;

function popLocalOption(args: ArgsSet): boolean {
   return args.popOption('--local') !== null || args.popOption('-l') !== null;
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
}
