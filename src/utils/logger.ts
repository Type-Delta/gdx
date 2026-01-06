import fs from 'fs';
import path from 'path';
import os from 'os';

import { ncc, strWrap } from '@lib/Tools';

import { quickPrint } from './utilities';
import { LOG_FILE_SIZE_LIMIT } from '@/consts';
import global from '@/global';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug';

const LogLevelMap: Record<LogLevel, number> = {
   fatal: 0,
   error: 1,
   warn: 2,
   info: 3,
   debug: 4,
};

const LogLevelColors: Record<LogLevel, 'BgRed' | 'BgYellow' | 'BgBlue' | 'BgCyan'> = {
   fatal: 'BgRed',
   error: 'BgRed',
   warn: 'BgYellow',
   info: 'BgBlue',
   debug: 'BgCyan',
};

const LogLevelBadges: Record<LogLevel, string> = {
   fatal: 'FATAL',
   error: 'ERROR',
   warn: 'WARN',
   info: 'INFO',
   debug: 'DEBUG',
};

const MessageColors: Record<LogLevel, 'Red' | 'Yellow' | 'Cyan' | 'Magenta'> = {
   fatal: 'Red',
   error: 'Red',
   warn: 'Yellow',
   info: 'Cyan',
   debug: 'Magenta',
};

class Logger {
   private moduleName: string;
   private static logFile: string = path.join(os.tmpdir(), 'gdx', 'gdx.log');
   private static initialized: boolean = false;
   private static allLogs: Array<{ timestamp: string; level: LogLevel; message: string; module: string }> = [];

   constructor(moduleName: string) {
      this.moduleName = moduleName;

      // Initialize exit handler and log directory on first Logger creation
      if (!Logger.initialized) {
         Logger.initialized = true;
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

   private log(level: LogLevel, message: string): void {
      const timestamp = new Date().toISOString();

      // Always store in allLogs
      Logger.allLogs.push({ timestamp, level, message, module: this.moduleName });

      // Check if we should print this message
      if (LogLevelMap[level] <= LogLevelMap[global.logLevel]) {
         this.printMessage(level, message);
      }
   }

   private printMessage(level: LogLevel, message: string): void {
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
         ` ${this.moduleName} ${ncc() + ncc(messageColor)} ${wrappedMessage}` +
         ncc();

      if (level === 'fatal' || level === 'error') {
         console.error(formattedMessage);
      } else {
         quickPrint(formattedMessage);
      }
   }

   public fatal(message: string): void {
      this.log('fatal', message);
   }

   public error(message: string): void {
      this.log('error', message);
   }

   public warn(message: string): void {
      this.log('warn', message);
   }

   public info(message: string): void {
      this.log('info', message);
   }

   public debug(message: string): void {
      this.log('debug', message);
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
