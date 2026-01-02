#!/usr/bin/env node
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIST_DIR = path.join(__dirname, '../dist');
const NATIVE_DIR = path.join(DIST_DIR, 'native');
const isWin = process.platform === 'win32';
const binaryName = isWin ? 'gdx.exe' : 'gdx';
const binaryPath = path.join(NATIVE_DIR, binaryName);

// Check if native binary exists
if (fs.existsSync(binaryPath)) {
   const child = spawn(binaryPath, process.argv.slice(2), {
      stdio: 'inherit'
   });

   child.on('close', (code) => {
      process.exit(code);
   });

   child.on('error', (err) => {
      console.error('Failed to start native binary:', err);
      process.exit(1);
   });
} else {
   // Fallback to Node.js runtime (dist/index.js)
   // Since dist/index.js is ESM, we use dynamic import
   const jsEntry = path.join(DIST_DIR, 'index.js');
   import(require('url').pathToFileURL(jsEntry)).catch(err => {
      console.error('Failed to load JS fallback:', err);
      process.exit(1);
   });
}
