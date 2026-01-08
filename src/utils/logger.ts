import fs from 'fs';
import path from 'path';
import os from 'os';

import { ncc, strWrap } from '@lib/Tools';

import { LOG_FILE_SIZE_LIMIT, SHOULD_WRITE_LOGS } from '@/consts';
import global from '@/global';

export type LogLevel = 'off' | 'fatal' | 'error' | 'warn' | 'info' | 'debug';

const LogLevelMap: Record<LogLevel, number> = {
   off: -1,
   fatal: 0,
   error: 1,
   warn: 2,
   info: 3,
   debug: 4,
};

const LogLevelColors: Record<LogLevel, 'BgRed' | 'BgYellow' | 'BgBlue' | 'BgCyan'> = {
   off: 'BgBlue',
   fatal: 'BgRed',
   error: 'BgRed',
   warn: 'BgYellow',
   info: 'BgBlue',
   debug: 'BgCyan',
};

const LogLevelBadges: Record<LogLevel, string> = {
   off: '',
   fatal: 'FATAL',
   error: 'ERROR',
   warn: 'WARN',
   info: 'INFO',
   debug: 'DEBUG',
};

const MessageColors: Record<LogLevel, 'Red' | 'Yellow' | 'Cyan' | 'Magenta'> = {
   off: 'Cyan',
   fatal: 'Red',
   error: 'Red',
   warn: 'Yellow',
   info: 'Cyan',
   debug: 'Magenta',
};

class Logger {
   static logFile: string = path.join(os.tmpdir(), 'gdx', 'gdx.log');

   private moduleName: string;
   private static initialized: boolean = false;
   private static allLogs: Array<{ timestamp: string; level: LogLevel; message: string; module: string }> = [];

   constructor(moduleName: string) {
      this.moduleName = moduleName;
      Logger.ensureInitialized();
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
      // Check if we should print this message
      if (LogLevelMap[level] <= LogLevelMap[global.logLevel]) {
         Logger.printMessage(level, message, moduleName);
      }

      if (!SHOULD_WRITE_LOGS) return;

      Logger.ensureInitialized();
      const timestamp = new Date().toISOString();

      // Always store in allLogs
      Logger.allLogs.push({ timestamp, level, message, module: moduleName });
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
