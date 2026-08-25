import { LogLevel } from './utils/logger';
import { Semaphore } from './utils/operation';

export default {
   exitCodeOverride: -1,
   finalStringOutput: '',
   logLevel: 'warn' as LogLevel,
   terminalWidth: process.stdout.columns || 100,
   indexArgs: true as boolean,
   runtimeShimActive: false,
   runtimeShimPathFallback: false,
   threadResources: new Semaphore(4) // temporary default, will be overritten by dispatch later
};
