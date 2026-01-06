export default {
   exitCodeOverride: -1,
   finalStringOutput: '',
   logLevel: 'warn' as 'fatal' | 'error' | 'warn' | 'info' | 'debug',
   terminalWidth: process.stdout.columns || 100,
};
