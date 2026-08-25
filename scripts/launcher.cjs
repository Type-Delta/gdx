#!/usr/bin/env node
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { constants: osConstants } = require('os');

const DIST_DIR = path.join(__dirname, '../dist');
const NATIVE_DIR = path.join(__dirname, '../bin/native');
const isWin = process.platform === 'win32';
const binaryName = isWin ? 'gdx.exe' : 'gdx';

if (
   (process.env.GDX_RUNTIME_SHIM === '1' || process.env.GDX_NODE_SHIM === '1') &&
   process.argv[2] === '--'
) {
   process.argv.splice(2, 1);
}

function getNativeBinaryPath() {
   return path.join(NATIVE_DIR, binaryName);
}

function runLauncher() {
   const binaryPath = getNativeBinaryPath();

   if (fs.existsSync(binaryPath)) {
      const child = spawn(binaryPath, process.argv.slice(2), {
         stdio: 'inherit'
      });
      const signalHandlers = new Map();

      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
         const handler = () => {
            if (child.exitCode === null && child.signalCode === null) child.kill(signal);
         };
         signalHandlers.set(signal, handler);
         process.on(signal, handler);
      }

      const removeSignalHandlers = () => {
         for (const [signal, handler] of signalHandlers) {
            process.off(signal, handler);
         }
      };

      child.once('close', (code, signal) => {
         removeSignalHandlers();
         if (signal) {
            const fallbackCode = 128 + (osConstants.signals[signal] || 0);
            try {
               process.kill(process.pid, signal);
               setImmediate(() => process.exit(fallbackCode));
            } catch {
               process.exit(fallbackCode);
            }
            return;
         }
         process.exit(code ?? 1);
      });

      child.once('error', (err) => {
         removeSignalHandlers();
         console.error('Failed to start native binary:', err);
         process.exit(1);
      });
   } else {
      const jsEntry = path.join(DIST_DIR, 'index.js');
      import(require('url').pathToFileURL(jsEntry)).catch(err => {
         console.error('Failed to load JS fallback:', err);
         process.exit(1);
      });
   }
}

if (require.main === module) {
   runLauncher();
}

module.exports = {
   getNativeBinaryPath,
   runLauncher,
};
