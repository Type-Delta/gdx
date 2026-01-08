import { LogLevel } from "./utils/logger";

export default {
   exitCodeOverride: -1,
   finalStringOutput: '',
   logLevel: 'warn' as LogLevel,
   terminalWidth: process.stdout.columns || 100,
};
