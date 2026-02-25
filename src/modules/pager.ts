import { maxFraction, ncc, strJustify, strWrap } from '@lib/Tools';

import Logger from '@/utils/logger';
import { bgRgb, fgRgb, getDisplayWidth, RgbVec, stripAnsiColor } from './graphics';
import { CATPPUCCIN_VPALETTE } from '@/consts';

/**
 * Options for configuring pager behavior.
 */
export interface PagerAction {
   /** Key(s) that trigger the action */
   key: string | string[];
   /** Action label for status bar */
   label: string;
   /** Action identifier to return */
   action: string;
}

export interface PagerStatusContext {
   statusText?: string | (() => string);
   actions?: PagerAction[];
}

export interface PagerActionResult {
   action: string;
   key: string;
}

export interface PagerOptions {
   /** Whether to show line numbers. Default: false */
   showLineNumbers?: boolean;
   /** Width of line number column. Default: 4 */
   lineNumberWidth?: number;
   /** Whether to wrap long lines. Default: true */
   wrapLines?: boolean;
   /** Whether to show status bar at bottom. Default: true */
   showStatus?: boolean;
   /** Custom status bar format function */
   statusFormat?: (
      current: number,
      total: number,
      termWidth: number,
      context?: PagerStatusContext
   ) => string;
   /** Optional status text for the status bar */
   statusText?: string | (() => string);
   /** Optional actions for interactive pager sessions */
   actions?: PagerAction[];
   /** Background color for the pager (24-bit RGB as [r, g, b]) */
   backgroundColor?: RgbVec;
   /**
    * How much to scroll when navigating by line. Can be increased for faster scrolling.
    */
   scrollSensitivity?: number;
}

/**
 * Interface for custom renderers that can be plugged into the pager.
 * This allows for exchangeable rendering backends (e.g., fzf integration).
 */
export interface PagerRenderer {
   /** Returns the total number of lines in the content */
   getLineCount: () => number;
   /** Returns a single line by index */
   getLine: (index: number) => string;
   /** Renders a viewport of lines starting from startLine */
   render: (startLine: number, height: number, width: number) => string[];
   /** Called when terminal is resized */
   onResize?: (width: number, height: number) => void;
   /** Called to get lines for scroll buffer on exit */
   getExitLines?: () => string[];
}

/** Default pager configuration */
const DEFAULT_OPTIONS: Required<PagerOptions> = {
   showLineNumbers: false,
   lineNumberWidth: 4,
   wrapLines: true,
   showStatus: true,
   statusFormat: (current, total, termWidth, context) => {
      const bright = ncc('Bright');
      const normal = ncc('Normal');
      const dim = ncc('Dim');
      const endLines = Math.min(current + getTerminalHeight() - 2, total);
      const statusText =
         typeof context?.statusText === 'function' ? context.statusText() : context?.statusText;
      const actionHint = context?.actions
         ? context.actions
            .map((action) => {
               const keys = Array.isArray(action.key) ? action.key : [action.key];
               const keyLabel = keys[0] ?? '';
               if (!keyLabel) return '';
               return `${bright}${keyLabel}${normal} ${action.label}`;
            })
            .filter(Boolean)
            .join(`${dim},${normal} `)
         : '';
      const navHint = actionHint
         ? `${bright}↑ ↓ b n${normal} navigate, ${bright}q${normal} quit`
         : `${bright}↑ ↓ b n Home End${normal} to navigate, ${bright}q${normal} quit`;
      const locationInfo = actionHint
         ? `lines ${bright}${current}-${endLines}${normal} of ${bright}${total}${endLines === total ? ncc('Red') + ' (EOF)' + ncc('White') : ''}`
         : `ln ${bright}${current}${normal} of ${bright}${total}${current === total ? ncc('Red') + ' EOF' + ncc('White') : ''}`;

      const leftParts = [statusText, navHint, actionHint].filter(Boolean);
      return '  ' + strJustify(
         [
            leftParts.join('  '),
            locationInfo,
         ],
         termWidth - 4, // Subtract 4 to account for the leading spaces and trailing spaces
         {
            align: 'spacebetween',
            filler: ' ',
            overflow: 'collapse',
            collapseLocation: 'mid',
            redundancyLv: 0,
         }
      ) + '  ';
   },
   backgroundColor: CATPPUCCIN_VPALETTE.base,
   scrollSensitivity: 3,
   statusText: '',
   actions: [],
};

/** Cached terminal dimensions */
let cachedTerminalHeight: number | null = null;
let cachedTerminalWidth: number | null = null;

/**
 * Gets the current terminal height, using cache if available.
 * @returns Terminal height in rows
 */
export function getTerminalHeight(): number {
   if (cachedTerminalHeight !== null) return cachedTerminalHeight;
   cachedTerminalHeight = process.stdout.rows || 24;
   return cachedTerminalHeight;
}

/**
 * Gets the current terminal width, using cache if available.
 * @returns Terminal width in columns
 */
export function getTerminalWidth(): number {
   if (cachedTerminalWidth !== null) return cachedTerminalWidth;
   cachedTerminalWidth = process.stdout.columns || 80;
   return cachedTerminalWidth;
}

/**
 * Clears the cached terminal dimensions.
 * Call this after terminal resize events.
 */
export function clearTerminalCache(): void {
   cachedTerminalHeight = null;
   cachedTerminalWidth = null;
}

/**
 * Simple pager renderer for plain text content.
 * Handles line wrapping and line numbers.
 */
export class SimplePagerRenderer implements PagerRenderer {
   private lines: string[] = [];
   private wrappedLines: string[] = [];
   private options: Required<PagerOptions>;
   private lastWidth: number = 0;
   private lastHeight: number = 0;

   constructor(content: string, options: PagerOptions = {}) {
      this.options = { ...DEFAULT_OPTIONS, ...options };
      this.lines = content.split('\n');
      this.lastWidth = getTerminalWidth();
      this.lastHeight = getTerminalHeight();
      this.updateWrappedLines();
   }

   private updateWrappedLines(): void {
      const width = this.lastWidth;
      const contentWidth = this.options.showLineNumbers
         ? width - this.options.lineNumberWidth - 1
         : width;

      this.wrappedLines = [];

      for (let i = 0; i < this.lines.length; i++) {
         const line = this.lines[i];

         if (this.options.wrapLines && line.length > contentWidth) {
            const wrapped = strWrap(line, contentWidth, { mode: 'softboundary' });
            const wrappedParts = wrapped.split('\n');
            wrappedParts.forEach((part, idx) => {
               if (this.options.showLineNumbers && idx === 0) {
                  this.wrappedLines.push(this.formatLineNumber(i + 1) + part);
               } else if (this.options.showLineNumbers) {
                  this.wrappedLines.push(' '.repeat(this.options.lineNumberWidth + 1) + part);
               } else {
                  this.wrappedLines.push(part);
               }
            });
         } else {
            if (this.options.showLineNumbers) {
               this.wrappedLines.push(this.formatLineNumber(i + 1) + line);
            } else {
               this.wrappedLines.push(line);
            }
         }
      }
   }

   private formatLineNumber(num: number): string {
      return String(num).padStart(this.options.lineNumberWidth) + ' ';
   }

   getLineCount(): number {
      return this.wrappedLines.length;
   }

   getLine(index: number): string {
      return this.wrappedLines[index] || '';
   }

   render(startLine: number, height: number, width: number): string[] {
      const result: string[] = [];
      const bgColor = bgRgb(this.options.backgroundColor);
      const reset = ncc();

      for (let i = 0; i < height - 1; i++) {
         const lineIndex = startLine + i;
         if (lineIndex < this.wrappedLines.length) {
            const line = this.wrappedLines[lineIndex];
            const stripped = stripAnsiColor(line);
            const padding = Math.max(0, width - stripped.length);
            result.push(`${bgColor}${line}${' '.repeat(padding)}${reset}`);
         } else {
            result.push(`${bgColor}${' '.repeat(width)}${reset}`);
         }
      }

      return result;
   }

   onResize(width: number, height: number): void {
      if (width !== this.lastWidth || height !== this.lastHeight) {
         this.lastWidth = width;
         this.lastHeight = height;
         this.updateWrappedLines();
      }
   }

   getExitLines(): string[] {
      return this.wrappedLines;
   }
}

/**
 * Displays content in an interactive pager with less-like navigation.
 * @param content - The text content to display
 * @param options - Pager configuration options
 */
export async function pager(
   content: string,
   options: PagerOptions = {}
): Promise<PagerActionResult | void> {
   const renderer = new SimplePagerRenderer(content, options);
   return pagerWithRenderer(renderer, options);
}

/**
 * Displays content using a custom renderer in an interactive pager.
 * @param renderer - Custom renderer implementing PagerRenderer interface
 * @param options - Pager configuration options
 */
export async function pagerWithRenderer(
   renderer: PagerRenderer,
   options: PagerOptions = {}
): Promise<PagerActionResult | void> {
   const opts = { ...DEFAULT_OPTIONS, ...options };

   // Non-TTY fallback: just print all lines
   if (!process.stdout.isTTY || !process.stdin.isTTY) {
      for (let i = 0; i < renderer.getLineCount(); i++) {
         process.stdout.write(renderer.getLine(i) + '\n');
      }
      return;
   }

   // Setup terminal for raw input
   process.stdin.setRawMode(true);
   process.stdin.resume();
   process.stdin.setEncoding('utf-8');

   let currentLine = 0;
   const totalLines = renderer.getLineCount();
   let isRunning = true;
   let actionResult: PagerActionResult | null = null;
   const performanceSamples: number[] = [];

   // Hide cursor and clear screen
   process.stdout.write('\x1b[?25l');
   process.stdout.write('\x1b[2J\x1b[H');

   /**
    * Renders the current viewport to the terminal.
    */
   function render(): void {
      const startTime = performance.now();
      const currentHeight = getTerminalHeight();
      const currentWidth = getTerminalWidth();
      const lines = renderer.render(currentLine, currentHeight, currentWidth);

      process.stdout.write('\x1b[H');

      for (const line of lines) {
         process.stdout.write('\x1b[K' + line + '\n');
      }

      // Status bar
      if (opts.showStatus) {
         const statusLine = opts.statusFormat(currentLine + 1, totalLines, currentWidth, {
            statusText: opts.statusText,
            actions: opts.actions,
         });
         const padding = Math.max(0, currentWidth - getDisplayWidth(statusLine));
         const bgColor = bgRgb(opts.backgroundColor);
         const dimColor = fgRgb(CATPPUCCIN_VPALETTE.overlay0);
         process.stdout.write(
            '\x1b[K' + bgColor + dimColor + statusLine + ' '.repeat(padding) + ncc()
         );
      }
      if (performanceSamples.length > 30) performanceSamples.shift();
      performanceSamples.push(performance.now() - startTime);
   }

   /**
    * Cleans up terminal state, leaving content in scroll buffer.
    */
   function cleanup(): void {
      // Show cursor
      process.stdout.write('\x1b[?25h');

      // Move to bottom of current viewport and add content to scroll buffer
      const currentHeight = getTerminalHeight();
      const linesToAdd = currentHeight - 1;

      // Move cursor to after the displayed content
      process.stdout.write(`\x1b[${linesToAdd}B`);

      process.stdin.setRawMode(false);
      process.stdin.pause();
      Logger.debug(
         `Pager performance: ${performanceSamples.length > 0 ? maxFraction(performanceSamples.reduce((a, b) => a + b, 0) / performanceSamples.length, 4) : 'N/A'}ms average over ${performanceSamples.length} renders`,
         'pager'
      );
   }

   /**
    * Handles terminal resize events.
    */
   function handleResize(): void {
      clearTerminalCache();
      const newWidth = getTerminalWidth();
      const newHeight = getTerminalHeight();

      if (renderer.onResize) {
         renderer.onResize(newWidth, newHeight);
      }

      render();
   }

   const resizeHandler = (): void => handleResize();
   process.stdout.on('resize', resizeHandler);

   /**
    * Handles keyboard input for navigation.
    * @param key - The key or escape sequence pressed
    */
   function handleKey(key: string): void {
      const currentHeight = getTerminalHeight();
      const visibleCount = currentHeight - 1;
      const maxLine = Math.max(0, renderer.getLineCount() - visibleCount);

      const actionBindings = opts.actions || [];
      if (actionBindings.length > 0) {
         for (const action of actionBindings) {
            const keys = Array.isArray(action.key) ? action.key : [action.key];
            if (keys.includes(key)) {
               actionResult = { action: action.action, key };
               isRunning = false;
               return;
            }
         }
      }

      switch (key) {
         case 'q':
         case '\x03': // Ctrl+C
         case '\x1b': // Escape
            if (actionBindings.length > 0 && !actionResult) {
               actionResult = { action: 'abort', key };
            }
            isRunning = false;
            break;
         case '\x1b[A': // Up arrow
         case '\u001b[\u0041':
         case 'k':
            currentLine = Math.max(0, currentLine - opts.scrollSensitivity);
            break;
         case '\x1b[B': // Down arrow
         case '\u001b[\u0042':
         case 'j':
            currentLine = Math.min(maxLine, currentLine + opts.scrollSensitivity);
            break;
         case '\x1b[5~': // Page Up
         case 'b': {
            const pageSize = visibleCount - 1;
            currentLine = Math.max(0, currentLine - pageSize);
            break;
         }
         case '\x1b[6~': // Page Down
         case 'n':
         case ' ': {
            const pageSize = visibleCount - 1;
            currentLine = Math.min(maxLine, currentLine + pageSize);
            break;
         }
         case 'g':
         case '\x1b[1~': // Home
         case '\x1b[H':
            currentLine = 0;
            break;
         case 'G':
         case '\x1b[4~': // End
         case '\x1b[F':
            currentLine = maxLine;
            break;
      }

      if (isRunning) {
         render();
      }
   }

   const keyHandler = (chunk: Buffer): void => {
      handleKey(chunk.toString());

      if (!isRunning) {
         process.stdin.off('data', keyHandler);
         process.stdout.off('resize', resizeHandler);
         cleanup();
      }
   };

   process.stdin.on('data', keyHandler);

   // Initial render
   render();

   // Wait for exit
   return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
         if (!isRunning) {
            clearInterval(checkInterval);
            resolve(actionResult || undefined);
         }
      }, 50);
   });
}
