import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { TEMP_DIR } from '../consts';

export interface StashEntry {
   sha: string;
   message: string;
   index?: number; // Original index, useful for logging
}

export interface StashDropOperation {
   timestamp: number;
   entries: StashEntry[]; // Ordered list of dropped stashes
   type: 'single' | 'range';
}

function getHistoryFilePath(repoPath: string): string {
   const hash = crypto.createHash('sha256').update(repoPath).digest('hex');
   const undoDir = path.join(TEMP_DIR, 'gdx', 'stash-undo');
   if (!fs.existsSync(undoDir)) {
      fs.mkdirSync(undoDir, { recursive: true });
   }
   return path.join(undoDir, `${hash}.json`);
}

function readHistory(repoPath: string): StashDropOperation[] {
   const file = getHistoryFilePath(repoPath);
   if (!fs.existsSync(file)) return [];
   try {
      const data = fs.readFileSync(file, 'utf-8');
      return JSON.parse(data);
   } catch {
      return [];
   }
}

function writeHistory(repoPath: string, history: StashDropOperation[]) {
   const file = getHistoryFilePath(repoPath);
   fs.writeFileSync(file, JSON.stringify(history, null, 2));
}

export function saveStashDrop(repoPath: string, operation: StashDropOperation, limit: number = 10) {
   const history = readHistory(repoPath);
   history.push(operation);

   // Cap at configured limit
   if (history.length > limit) {
      // Remove oldest entries until we fit the limit
      history.splice(0, history.length - limit);
   }

   writeHistory(repoPath, history);
}

export function popLastStashDrop(repoPath: string): StashDropOperation | null {
   const history = readHistory(repoPath);
   if (history.length === 0) return null;

   const operation = history.pop() || null;
   writeHistory(repoPath, history);
   return operation;
}
