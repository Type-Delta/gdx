import fs from 'fs';
import path from 'path';

import { cleanString, jsTime, ncc, strWrap } from '@lib/Tools';

import { LOG_FILE_SIZE_LIMIT, LOG_PATH, SHOULD_WRITE_LOGS, VERSION } from '@/consts';
import global from '@/global';

export type LogLevel = 'off' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

export interface LogRecord {
   timestamp: string;
   level: LogLevel;
   message: string;
   module: string;
}

type LoggerSink = (record: LogRecord) => void;

let loggerSink: LoggerSink | null = null;

export function setLoggerSink(sink: LoggerSink | null): void {
   loggerSink = sink;
}

const LogLevelMap: Record<LogLevel, number> = {
   off: -1,
   fatal: 0,
   error: 1,
   warn: 2,
   info: 3,
   debug: 4,
   verbose: 5,
};

const LogLevelColors = {
   off: 'BgBlue',
   fatal: 'BgRed',
   error: 'BgRed',
   warn: 'BgYellow',
   info: 'BgBlue',
   debug: 'BgMagenta',
   verbose: 'BgCyan',
} as const satisfies Record<LogLevel, string>;

const LogLevelBadges: Record<LogLevel, string> = {
   off: '',
   fatal: 'FATAL',
   error: 'ERROR',
   warn: 'WARN',
   info: 'INFO',
   debug: 'DEBUG',
   verbose: 'VERBOSE',
} as const;

const MessageColors = {
   off: 'Cyan',
   fatal: 'Red',
   error: 'Red',
   warn: 'Yellow',
   info: 'Cyan',
   debug: 'Magenta',
   verbose: 'Blue',
} as const satisfies Record<LogLevel, string>;

class Logger {
   static logFile: string = LOG_PATH;
   static logLevel: number = LogLevelMap[global.logLevel];
   static timeLabels: Map<string, number> = new Map();

   private moduleName: string;
   private static initialized: boolean = false;
   private static allLogs: Array<{
      timestamp: string;
      level: LogLevel;
      message: string;
      module: string;
   }> = [
         {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: `\n\n=== New gdx session started ===\nLocalMachineDate: ${new Date().toLocaleString()}\nAppVersion: ${VERSION}\nPlatform: ${process.platform}\nArch: ${process.arch}\n`,
            module: 'logger',
         },
      ];

   constructor(moduleName: string) {
      this.moduleName = moduleName;
      Logger.ensureInitialized();
   }

   /**
    * Checks if a message at the given level would be logged based on the current global log level.
    * This can be used to avoid expensive log message construction when the message would not be logged.
    * @param level The log level to check.
    * @returns True if a message at the given level would be logged, false otherwise.
    */
   static wouldLog(level: LogLevel): boolean {
      return LogLevelMap[level] <= Logger.logLevel;
   }

   private static ensureInitialized(): void {
      if (!Logger.initialized) {
         Logger.initialized = true;

         if (!SHOULD_WRITE_LOGS) return;
         Logger.initializeLogDirectory();
         process.on('exit', () => Logger.flushLogs());
      }
   }

   private static initializeLogDirectory(): void {
      const logDir = path.dirname(Logger.logFile);
      try {
         if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
         }
      } catch {
         // Silently fail if we can't create the directory
      }
   }

   private static logInternal(level: LogLevel, message: string, moduleName: string): void {
      const timestamp = new Date().toISOString();

      // Create log record (for sink and file)
      const record: LogRecord = { timestamp, level, message, module: moduleName };

      // Call sink unconditionally (for test buffer.logs, even when SHOULD_WRITE_LOGS is false)
      if (loggerSink) {
         loggerSink(record);
      }

      // Check if we should print this message
      if (LogLevelMap[level] <= LogLevelMap[global.logLevel]) {
         Logger.printMessage(level, message, moduleName);
      }

      if (!SHOULD_WRITE_LOGS) return;

      Logger.ensureInitialized();

      // Always store in allLogs (for file flush)
      Logger.allLogs.push(record);
   }

   private static printMessage(level: LogLevel, message: string, moduleName: string): void {
      const bgColor = LogLevelColors[level];
      const badge = LogLevelBadges[level];
      const messageColor = MessageColors[level];

      const wrappedMessage = strWrap(message, 100, {
         indent: '  ',
      });

      const formattedMessage =
         ncc(bgColor) +
         ncc('Bright') +
         ncc('White') +
         ` ${badge} ` +
         ncc() +
         ncc('Invert') +
         ` ${moduleName} ${ncc() + ncc(messageColor)} ${wrappedMessage}` +
         ncc();

      if (level === 'fatal' || level === 'error') {
         process.stderr.write(formattedMessage + '\n');
      } else {
         process.stdout.write(formattedMessage + '\n');
      }
   }

   // Instance methods
   public fatal(message: string): void {
      Logger.logInternal('fatal', message, this.moduleName);
   }

   public error(message: string): void {
      Logger.logInternal('error', message, this.moduleName);
   }

   public warn(message: string): void {
      Logger.logInternal('warn', message, this.moduleName);
   }

   public info(message: string): void {
      Logger.logInternal('info', message, this.moduleName);
   }

   public debug(message: string): void {
      Logger.logInternal('debug', message, this.moduleName);
   }

   public verbose(message: string): void {
      Logger.logInternal('verbose', message, this.moduleName);
   }

   /**
    * Starts a timer with the given label. If only the label is provided, it stores the start time internally and returns void.
    * If a function is also provided, it executes the function and logs the time taken with the given label, then returns the function's result.
     * @param label The label for the timer.
     * @param fn Optional function to execute and time. If not provided, the timer will just store the start time.
     * @returns The result of the function if provided, otherwise void.
    */
   public time(label: string): void
   public time<T>(label: string, fn: () => T): T
   public time<T>(label: string, fn?: () => T): T | void {
      if (!fn) {
         Logger.timeLabels.set(label, performance.now());
         return;
      }

      return Logger.time(label, fn, this.moduleName);
   }

   /**
    * Ends a timer with the given label and logs the time taken. The label must have been previously started with the time() method.
    * @param label The label for the timer to end.
     * @returns void
    */
   public timeEnd(label: string): void {
      Logger.timeEnd(label, this.moduleName);
   }

   /**
    * Starts a timer with the given label, executes the provided async function, and logs the time taken with the given label. Then returns the function's result.
     * @param label The label for the timer.
     * @param fn The async function to execute and time.
     * @returns The result of the async function.
     * @example
     * await logger.timeAsync('fetchData', async () => {
     *    const data = await fetchDataFromAPI();
     *    return data;
     * });
     * // Logs: "fetchData took 123ms" under 'myModule' and returns the fetched data.
    */
   public async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
      return await Logger.timeAsync(label, fn, this.moduleName);
   }

   // Static methods
   public static fatal(message: string, moduleName: string = 'gdx'): void {
      Logger.logInternal('fatal', message, moduleName);
   }

   public static error(message: string, moduleName: string = 'gdx'): void {
      Logger.logInternal('error', message, moduleName);
   }

   public static warn(message: string, moduleName: string = 'gdx'): void {
      Logger.logInternal('warn', message, moduleName);
   }

   public static info(message: string, moduleName: string = 'gdx'): void {
      Logger.logInternal('info', message, moduleName);
   }

   public static debug(message: string, moduleName: string = 'gdx'): void {
      Logger.logInternal('debug', message, moduleName);
   }

   public static verbose(message: string, moduleName: string = 'gdx'): void {
      Logger.logInternal('verbose', message, moduleName);
   }

   /**
    * Starts a timer with the given label, executes the provided async function, and logs the time taken with the given label. Then returns the function's result.
     * @param label The label for the timer.
     * @param fn The async function to execute and time.
     * @param moduleName Optional module name for logging. Defaults to 'gdx'.
     * @returns The result of the async function.
     * @example
     * await Logger.timeAsync('fetchData', async () => {
     *    const data = await fetchDataFromAPI();
     *    return data;
     * }, 'myModule');
     * // Logs: "fetchData took 123ms" under 'myModule' and returns the fetched data.
    */
   public static async timeAsync<T>(label: string, fn: () => T | Promise<T>, moduleName: string = 'gdx'): Promise<T> {
      const start = performance.now();
      try {
         return await fn();
      } finally {
         const end = performance.now();
         const duration = jsTime.getTimeFromMS(end - start).modern();
         Logger.debug(`${label} took ${duration}`, moduleName);
      }
   }

   /**
    * Starts a timer with the given label. If only the label is provided, it stores the start time internally and returns void.
    * If a function is also provided, it executes the function and logs the time taken with the given label, then returns the function's result.
     * @param label The label for the timer.
     * @param fn Optional function to execute and time. If not provided, the timer will just store the start time.
     * @param moduleName Optional module name for logging. Defaults to 'gdx'.
     * @returns The result of the function if provided, otherwise void.
    */
   public static time(label: string): void
   public static time<T>(label: string, fn: () => T, moduleName?: string): T
   public static time<T>(label: string, fn?: () => T, moduleName: string = 'gdx'): T | void {
      const start = performance.now();
      if (!fn) {
         Logger.timeLabels.set(label, start);
         return;
      }

      try {
         return fn();
      } finally {
         const end = performance.now();
         const duration = jsTime.getTimeFromMS(end - start).modern();
         Logger.debug(`${label} took ${duration}`, moduleName);
      }
   }

   /**
    * Ends a timer with the given label and logs the time taken. The label must have been previously started with the time() method.
    * @param label The label for the timer to end.
    * @param moduleName Optional module name for logging. Defaults to 'gdx'.
    * @returns void
    */
   public static timeEnd(label: string, moduleName: string = 'gdx'): void {
      const end = performance.now();
      const start = Logger.timeLabels.get(label);
      if (start) {
         const duration = jsTime.getTimeFromMS(end - start).modern();
         Logger.debug(`${label} took ${duration}`, moduleName);
         Logger.timeLabels.delete(label);
      } else {
         Logger.warn(`No such label '${label}' for timeEnd`, moduleName);
      }
   }

   private static flushLogs(): void {
      if (Logger.allLogs.length === 0) {
         return;
      }

      try {
         const logDir = path.dirname(Logger.logFile);
         if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
         }

         let fileContent = '';

         // Read existing log file if it exists
         if (fs.existsSync(Logger.logFile)) {
            fileContent = fs.readFileSync(Logger.logFile, 'utf-8');
         }

         // Format new logs
         const newLogs = Logger.allLogs
            .map(({ timestamp, level, message, module }) => {
               const paddedLevel = level.toUpperCase().padEnd(5);
               message = strWrap(cleanString(message), 100, {
                  indent: 33,
                  redundancyLv: -1,
                  mode: 'strict',
               });

               return `${timestamp} [${paddedLevel}] ${module}: ${message}`;
            })
            .join('\n');

         // Combine content
         let combinedContent = fileContent ? fileContent + '\n' + newLogs : newLogs;

         // Check file size and rotate if necessary
         const sizeBytes = Buffer.byteLength(combinedContent, 'utf-8');
         if (sizeBytes > LOG_FILE_SIZE_LIMIT) {
            // Remove first half of content
            const lines = combinedContent.split('\n');
            const removeCount = Math.floor(lines.length / 2);
            combinedContent = lines.slice(removeCount).join('\n');
         }

         fs.writeFileSync(Logger.logFile, combinedContent, 'utf-8');
      } catch {
         // Silently fail if we can't write the log file
      }
   }
}

export default Logger;
