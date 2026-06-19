import ttys from '@/modules/tty-strings';

/**
 * A decoded keyboard event parsed from raw terminal input.
 */
export interface KeyEvent {
   /** Key name (e.g. 'char', 'left', 'backspace', 'enter') or a letter for Ctrl/Alt chords. */
   name: string;
   /** The printable character, only present when `name` is 'char'. */
   char?: string;
   ctrl: boolean;
   alt: boolean;
   shift: boolean;
}

/** Options for the standalone line reader. */
export interface ReadLineOptions {
   /** Pre-filled editable text. */
   initial?: string;
}

/** Characters considered part of a word for word-wise navigation/deletion. */
const WORD_CHAR_REGEX = /[\p{L}\p{N}_]/u;

/** CSI final-byte → key name map for arrow/home/end sequences. */
const CSI_FINAL_KEYS: Record<string, string> = {
   A: 'up',
   B: 'down',
   C: 'right',
   D: 'left',
   H: 'home',
   F: 'end',
};

/** CSI `<n>~` keycode → key name map. */
const CSI_TILDE_KEYS: Record<string, string> = {
   1: 'home',
   2: 'insert',
   3: 'delete',
   4: 'end',
   5: 'pageup',
   6: 'pagedown',
   7: 'home',
   8: 'end',
};

/**
 * Creates a key event with default modifier flags.
 * @param name - Key name.
 * @param mods - Modifier or char overrides.
 * @returns The constructed key event.
 */
function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
   return { name, ctrl: false, alt: false, shift: false, ...mods };
}

/**
 * Decodes an xterm modifier parameter (1=plain, 2=shift, 3=alt, 5=ctrl, ...).
 * @param mod - Raw modifier parameter from a CSI sequence.
 * @returns Modifier flags for a key event.
 */
function decodeModifier(mod?: number): Partial<KeyEvent> {
   if (!mod || mod < 2) return {};
   const bits = mod - 1;
   return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

/**
 * Parses a CSI escape sequence body into a key event.
 * @param params - Parameter bytes between `ESC [` and the final byte.
 * @param final - Final byte of the sequence.
 * @returns The decoded key event, or null for unsupported sequences.
 */
function parseCsi(params: string, final: string): KeyEvent | null {
   const parts = params ? params.split(';').map(Number) : [];

   if (final === '~') {
      const name = CSI_TILDE_KEYS[String(parts[0] ?? '')];
      if (!name) return null;
      return key(name, decodeModifier(parts[1]));
   }
   if (final === 'Z') return key('tab', { shift: true });

   // CSI-u (fixterms / kitty): `<codepoint>;<modifier>u`. Only emitted by
   // terminals in an enhanced keyboard mode; lets us distinguish chords like
   // Ctrl+Shift+P from Ctrl+P. Unmodified/shift-only keys stay plain chars.
   if (final === 'u') {
      const codePoint = parts[0];
      if (!codePoint || Number.isNaN(codePoint)) return null;
      const mods = decodeModifier(parts[1]);
      const ch = String.fromCodePoint(codePoint);
      if (!mods.ctrl && !mods.alt) return key('char', { char: ch, shift: mods.shift ?? false });
      return key(ch.toLowerCase(), mods);
   }

   const name = CSI_FINAL_KEYS[final];
   if (!name) return null;
   return key(name, decodeModifier(parts[1]));
}

/**
 * Parses raw terminal input (raw mode) into a sequence of key events.
 *
 * Handles CSI/SS3 escape sequences with xterm modifiers (Ctrl/Alt/Shift +
 * arrows, Home/End, Delete), Alt-prefixed characters, control characters,
 * bracketed paste, and plain printable input (including surrogate pairs).
 *
 * @param data - Raw input chunk from stdin.
 * @returns Decoded key events in input order.
 */
export function parseInput(data: string): KeyEvent[] {
   const keys: KeyEvent[] = [];
   let i = 0;

   while (i < data.length) {
      const char = data[i];

      if (char === '\x1b') {
         // Bracketed paste: emit content as plain character events
         if (data.startsWith('\x1b[200~', i)) {
            const end = data.indexOf('\x1b[201~', i + 6);
            const content = end === -1 ? data.slice(i + 6) : data.slice(i + 6, end);
            for (const pasted of content) {
               if (pasted >= ' ' && pasted !== '\x7f') keys.push(key('char', { char: pasted }));
            }
            i = end === -1 ? data.length : end + 6;
            continue;
         }

         const csiMatch = data.slice(i).match(/^\x1b\[([0-9;]*)([A-Za-z~])/);
         if (csiMatch) {
            const parsed = parseCsi(csiMatch[1], csiMatch[2]);
            if (parsed) keys.push(parsed);
            i += csiMatch[0].length;
            continue;
         }

         const ss3Match = data.slice(i).match(/^\x1bO([A-Z])/);
         if (ss3Match) {
            const name = CSI_FINAL_KEYS[ss3Match[1]];
            if (name) keys.push(key(name));
            i += 3;
            continue;
         }

         const next = data[i + 1];
         if (next === '\x7f' || next === '\x08') {
            keys.push(key('backspace', { alt: true }));
            i += 2;
            continue;
         }
         if (next === '\r' || next === '\n') {
            keys.push(key('enter', { alt: true }));
            i += 2;
            continue;
         }
         if (next !== undefined && next >= ' ') {
            keys.push(key(next.toLowerCase(), { alt: true, shift: next !== next.toLowerCase() }));
            i += 2;
            continue;
         }

         keys.push(key('escape'));
         i++;
         continue;
      }

      if (char === '\r' || char === '\n') {
         keys.push(key('enter'));
         if (char === '\r' && data[i + 1] === '\n') i++;
         i++;
         continue;
      }
      if (char === '\t') {
         keys.push(key('tab'));
         i++;
         continue;
      }
      if (char === '\x7f') {
         keys.push(key('backspace'));
         i++;
         continue;
      }
      if (char === '\x08') {
         // Most terminals (incl. Windows Terminal) send BS for Ctrl+Backspace
         keys.push(key('backspace', { ctrl: true }));
         i++;
         continue;
      }

      const code = char.charCodeAt(0);
      if (code < 32) {
         keys.push(key(String.fromCharCode(code + 96), { ctrl: true }));
         i++;
         continue;
      }

      const codePoint = data.codePointAt(i);
      if (codePoint === undefined) break;
      const fullChar = String.fromCodePoint(codePoint);
      keys.push(key('char', { char: fullChar }));
      i += fullChar.length;
   }

   return keys;
}

/**
 * A single-line text buffer with cursor management and word-wise editing.
 *
 * Used as the editing core for both `readLine()` and Form textbox widgets.
 * Operates on Unicode code points so cursor math stays consistent for
 * non-BMP characters.
 */
export class LineBuffer {
   private chars: string[];
   /** Cursor position in code points (0..length). */
   cursor: number;

   constructor(initial = '') {
      this.chars = Array.from(initial);
      this.cursor = this.chars.length;
   }

   /** Current buffer content. */
   get text(): string {
      return this.chars.join('');
   }

   /** Buffer length in code points. */
   get length(): number {
      return this.chars.length;
   }

   /**
    * Returns the character at the given code-point index.
    * @param index - Code-point index.
    */
   charAt(index: number): string | undefined {
      return this.chars[index];
   }

   /**
    * Returns a substring by code-point range.
    * @param start - Start index (inclusive).
    * @param end - End index (exclusive).
    */
   slice(start: number, end?: number): string {
      return this.chars.slice(start, end).join('');
   }

   /**
    * Inserts text at the cursor and advances the cursor past it.
    * @param value - Text to insert.
    */
   insert(value: string): void {
      const inserted = Array.from(value);
      this.chars.splice(this.cursor, 0, ...inserted);
      this.cursor += inserted.length;
   }

   /** Replaces the entire buffer content and moves the cursor to the end. */
   setText(value: string): void {
      this.chars = Array.from(value);
      this.cursor = this.chars.length;
   }

   /** Finds the index of the previous word boundary from the cursor. */
   private prevWordBoundary(): number {
      let i = this.cursor;
      while (i > 0 && !WORD_CHAR_REGEX.test(this.chars[i - 1])) i--;
      while (i > 0 && WORD_CHAR_REGEX.test(this.chars[i - 1])) i--;
      return i;
   }

   /** Finds the index of the next word boundary from the cursor. */
   private nextWordBoundary(): number {
      let i = this.cursor;
      while (i < this.chars.length && !WORD_CHAR_REGEX.test(this.chars[i])) i++;
      while (i < this.chars.length && WORD_CHAR_REGEX.test(this.chars[i])) i++;
      return i;
   }

   /** Deletes one character before the cursor. */
   backspace(): void {
      if (this.cursor === 0) return;
      this.chars.splice(this.cursor - 1, 1);
      this.cursor--;
   }

   /** Deletes one character at the cursor. */
   deleteForward(): void {
      if (this.cursor >= this.chars.length) return;
      this.chars.splice(this.cursor, 1);
   }

   /** Deletes from the previous word boundary to the cursor. */
   deleteWordLeft(): void {
      const boundary = this.prevWordBoundary();
      this.chars.splice(boundary, this.cursor - boundary);
      this.cursor = boundary;
   }

   /** Deletes from the cursor to the next word boundary. */
   deleteWordRight(): void {
      const boundary = this.nextWordBoundary();
      this.chars.splice(this.cursor, boundary - this.cursor);
   }

   /** Deletes from the start of the line to the cursor. */
   deleteToStart(): void {
      this.chars.splice(0, this.cursor);
      this.cursor = 0;
   }

   /** Deletes from the cursor to the end of the line. */
   deleteToEnd(): void {
      this.chars.splice(this.cursor);
   }

   /**
    * Applies a key event to the buffer (movement and editing keys).
    * @param event - Decoded key event.
    * @returns True when the event was consumed by the buffer.
    */
   handleKey(event: KeyEvent): boolean {
      if (event.name === 'char' && event.char !== undefined && !event.ctrl && !event.alt) {
         this.insert(event.char);
         return true;
      }

      switch (event.name) {
         case 'left':
            this.cursor = event.ctrl || event.alt ? this.prevWordBoundary() : Math.max(0, this.cursor - 1);
            return true;
         case 'right':
            this.cursor =
               event.ctrl || event.alt
                  ? this.nextWordBoundary()
                  : Math.min(this.chars.length, this.cursor + 1);
            return true;
         case 'home':
            this.cursor = 0;
            return true;
         case 'end':
            this.cursor = this.chars.length;
            return true;
         case 'backspace':
            if (event.ctrl || event.alt) this.deleteWordLeft();
            else this.backspace();
            return true;
         case 'delete':
            if (event.ctrl || event.alt) this.deleteWordRight();
            else this.deleteForward();
            return true;
         case 'b':
            if (!event.alt) return false;
            this.cursor = this.prevWordBoundary();
            return true;
         case 'f':
            if (!event.alt) return false;
            this.cursor = this.nextWordBoundary();
            return true;
         case 'a':
            if (!event.ctrl) return false;
            this.cursor = 0;
            return true;
         case 'e':
            if (!event.ctrl) return false;
            this.cursor = this.chars.length;
            return true;
         case 'u':
            if (!event.ctrl) return false;
            this.deleteToStart();
            return true;
         case 'k':
            if (!event.ctrl) return false;
            this.deleteToEnd();
            return true;
         case 'w':
            if (!event.ctrl) return false;
            this.deleteWordLeft();
            return true;
      }
      return false;
   }
}

/**
 * Reads a single line of input with rich editing support.
 *
 * Unlike node's readline, this supports Ctrl/Alt+Left/Right word jumps,
 * Ctrl+Backspace / Ctrl+Delete word deletion, Home/End, Ctrl+U/K kills, and
 * a horizontal viewport for content longer than the terminal width.
 *
 * Falls back to node's readline when stdin/stdout is not a TTY.
 * Ctrl+C exits the process with code 130 (like a regular SIGINT).
 *
 * @param question - Prompt text printed before the input area.
 * @param options - Line reader options.
 * @returns The entered line (untrimmed).
 */
export async function readLine(question: string, options: ReadLineOptions = {}): Promise<string> {
   if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const { createInterface } = await import('readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
         rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
         });
      });
   }

   const stdin = process.stdin;
   const stdout = process.stdout;
   const buffer = new LineBuffer(options.initial ?? '');
   const promptWidth = ttys.stringWidth(question);
   let viewOffset = 0;

   const wasRaw = stdin.isRaw === true;
   stdin.setRawMode(true);
   stdin.resume();
   stdin.setEncoding('utf-8');

   /** Redraws the prompt line and repositions the cursor. */
   const render = (): void => {
      const width = stdout.columns || 80;
      const avail = Math.max(8, width - promptWidth - 1);
      if (buffer.cursor < viewOffset) viewOffset = buffer.cursor;
      if (buffer.cursor > viewOffset + avail) viewOffset = buffer.cursor - avail;
      if (viewOffset > 0 && buffer.length - viewOffset < avail) {
         viewOffset = Math.max(0, buffer.length - avail);
      }

      const visible = buffer.slice(viewOffset, viewOffset + avail);
      stdout.write('\x1b[2K\r' + question + visible);
      const col = promptWidth + ttys.stringWidth(buffer.slice(viewOffset, buffer.cursor));
      stdout.write('\r' + (col > 0 ? `\x1b[${col}C` : ''));
   };

   return new Promise((resolve) => {
      const cleanup = (): void => {
         stdin.off('data', onData);
         stdin.setRawMode(wasRaw);
         stdin.pause();
         stdout.write('\n');
      };

      const onData = (data: string): void => {
         for (const event of parseInput(data)) {
            if (event.name === 'enter') {
               cleanup();
               resolve(buffer.text);
               return;
            }
            if (event.ctrl && event.name === 'c') {
               cleanup();
               process.exit(130);
            }
            if (event.ctrl && event.name === 'd' && buffer.length === 0) {
               cleanup();
               resolve('');
               return;
            }
            buffer.handleKey(event);
         }
         render();
      };

      stdin.on('data', onData);
      render();
   });
}
