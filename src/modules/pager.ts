import { estimateStrComplexity, ex_length, maxFraction, strJustify, strWrap } from '@lib/Tools';

import Logger from '@/utils/logger';
import {
   bgRgb,
   colorMix,
   fgRgb,
   inferAnsiStyles,
   RgbVec,
   serializeAnsiStyles,
   stripAnsiColor,
} from './graphics';
import { CATPPUCCIN_VPALETTE, SGR } from '@/consts';
import { getConfig } from '@/common/config';

/**
 * Options for configuring pager behavior.
 */
export interface PagerAction {
   /** Key(s) that trigger the action */
   key: string | string[];
   /** Optional human-readable key label for the status bar */
   displayKey?: string;
   /** Action label for status bar */
   label: string;
   /** Action identifier to return */
   action: string;
}

export interface PagerStatusContext {
   statusText?: string | (() => string);
   actions?: PagerAction[];
   copyModeAvailable?: boolean;
   redundancyLv?: number;
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
   /** Redundancy level for string width calculations */
   redundancyLv?: number;
   /**
    * How much to scroll when navigating by line. Can be increased for faster scrolling.
    */
   scrollSensitivity?: number;
   /**
    * Behavior when exiting the pager. 'nextLine' keeps content in scroll buffer and moves the cursor to the next line below the content, 'clearScreen' clears the screen to remove pager content from scroll buffer, and 'none' leaves the content and cursor position unchanged.
    *
    * Default is 'nextLine'.
    */
   exitBehavior?: 'nextLine' | 'clearScreen' | 'none';
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
   /** Updates renderer options that can change while the pager is active */
   updateOptions?: (options: Partial<PagerOptions>) => void;
}

/** Default pager configuration */
export const PAGER_DEFAULT_OPTIONS: Omit<Required<PagerOptions>, 'redundancyLv'> = {
   showLineNumbers: false,
   lineNumberWidth: 5,
   wrapLines: true,
   showStatus: true,
   statusFormat: (current, total, termWidth, context) => {
      const cyan = fgRgb(CATPPUCCIN_VPALETTE.cyan);
      const white = fgRgb(CATPPUCCIN_VPALETTE.overlay0);
      const endLines = Math.min(current + getTerminalHeight() - 2, total);
      const statusText =
         typeof context?.statusText === 'function' ? context.statusText() : context?.statusText;
      const actionHint = context?.actions
         ? context.actions
            .map((action) => {
               const keys = Array.isArray(action.key) ? action.key : [action.key];
               const keyLabel = action.displayKey ?? keys[0] ?? '';
               if (!keyLabel) return '';
               return `${SGR.bright + cyan}${keyLabel}${white + SGR.normal} ${action.label}`;
            })
            .filter(Boolean)
            .join(`${SGR.dim},${SGR.normal} `)
         : '';
      const navHintParts = [
         actionHint
            ? `${SGR.bright + cyan}↑ ↓ b n${white + SGR.normal} navigate`
            : `${SGR.bright + cyan}↑ ↓ b n Home End${white + SGR.normal} to navigate`,
      ];
      if (context?.copyModeAvailable) {
         navHintParts.push(`${SGR.bright + cyan}c${white + SGR.normal} copy mode`);
      }
      navHintParts.push(`${SGR.bright + cyan}q${white + SGR.normal} quit`);
      const navHint =
         navHintParts.join(`${SGR.dim},${SGR.normal} `) +
         (actionHint ? `${SGR.dim},${SGR.normal}` : '');

      const leftParts = [statusText, navHint, actionHint].filter(Boolean).join(' ');

      const locationInfo =
         ex_length(leftParts, 0) > termWidth * 0.6
            ? `ln ${SGR.bright}${current}${SGR.normal} of ${SGR.bright}${total}${endLines === total ? SGR.red + ' EOF' + SGR.white : ''}`
            : `ln ${SGR.bright}${current}-${endLines}${SGR.normal} of ${SGR.bright}${total}${endLines === total ? SGR.red + ' (EOF)' + SGR.white : ''}`;
      return (
         '  ' +
         strJustify(
            [leftParts, locationInfo],
            termWidth - 4, // Subtract 4 to account for the leading spaces and trailing spaces
            {
               align: 'spacebetween',
               filler: ' ',
               overflow: 'collapse',
               collapseLocation: 'mid',
               redundancyLv: context?.redundancyLv ?? 0,
            }
         ) +
         '  '
      );
   },
   backgroundColor: CATPPUCCIN_VPALETTE.base,
   scrollSensitivity: 3,
   statusText: '',
   actions: [],
   exitBehavior: 'none',
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
   private renderedLines: string[] = [];
   private options: Required<PagerOptions>;
   private lastWidth: number = 0;
   private lastHeight: number = 0;
   private redundancyLv: number = 0;

   constructor(content: string, options: PagerOptions = {}) {
      this.options = {
         ...PAGER_DEFAULT_OPTIONS,
         ...options,
      } as Required<PagerOptions>;
      this.redundancyLv = options.redundancyLv ?? estimateStrComplexity(content);
      this.lines = content.split('\n');
      this.lastWidth = getTerminalWidth();
      this.lastHeight = getTerminalHeight();
      this.updateRenderedLines();
   }

   private updateRenderedLines(): void {
      const width = this.lastWidth;
      const gutterRPad = this.options.lineNumberWidth <= 5 ? 1 : 2;
      const gutterBg = colorMix(CATPPUCCIN_VPALETTE.mantle, CATPPUCCIN_VPALETTE.surface0, 0.2);
      const contentBg = bgRgb(this.options.backgroundColor);
      const contentWidth = this.options.showLineNumbers
         ? width - this.options.lineNumberWidth
         : width;

      this.renderedLines = [];

      for (let i = 0; i < this.lines.length; i++) {
         const line = this.lines[i];

         if (this.options.wrapLines && ex_length(line, this.redundancyLv) > contentWidth) {
            const wrapped = strWrap(line, contentWidth, {
               mode: 'strict',
               redundancyLv: Math.max(0, this.redundancyLv),
            });
            const splitted = wrapped.split('\n');
            const gutter = this.options.showLineNumbers ? this.formatLineNumber(i + 1, gutterRPad, gutterBg) : '';
            let lastStyles;
            for (let i = 0; i < splitted.length; i++) {
               const g = i === 0 ? gutter : this.formatLineNumber(-1, gutterRPad, gutterBg);

               if (lastStyles) splitted[i] = serializeAnsiStyles(lastStyles) + splitted[i];

               this.renderedLines.push(g + contentBg + splitted[i]);

               if (i != splitted.length - 1) lastStyles = inferAnsiStyles(splitted[i]);
            }
         } else {
            if (this.options.showLineNumbers) {
               this.renderedLines.push(this.formatLineNumber(i + 1, gutterRPad, gutterBg) + contentBg + line);
            } else {
               this.renderedLines.push(contentBg + line);
            }
         }
      }
   }

   private formatLineNumber(num: number, rPad: number, bg: RgbVec): string {
      if (num === -1) return bgRgb(bg) + ' '.repeat(this.options.lineNumberWidth);
      return fgRgb(CATPPUCCIN_VPALETTE.overlay1)
         + bgRgb(bg)
         + strJustify(String(num), this.options.lineNumberWidth - rPad, { align: 'right' })
         + ' '.repeat(rPad);
   }

   getLineCount(): number {
      return this.renderedLines.length;
   }

   getLine(index: number): string {
      return this.renderedLines[index] || '';
   }

   render(startLine: number, height: number, width: number): string[] {
      const result: string[] = [];
      const bgColor = bgRgb(this.options.backgroundColor);

      for (let i = 0; i < height - 1; i++) {
         const lineIndex = startLine + i;
         if (lineIndex < this.renderedLines.length) {
            const line = this.renderedLines[lineIndex];
            const stripped = stripAnsiColor(line);
            const padding = Math.max(0, width - ex_length(stripped, this.redundancyLv));
            result.push(`${bgColor}${line}${' '.repeat(padding)}${SGR.reset}`);
         } else {
            result.push(`${bgColor}${' '.repeat(width)}${SGR.reset}`);
         }
      }

      return result;
   }

   onResize(width: number, height: number): void {
      if (width !== this.lastWidth || height !== this.lastHeight) {
         this.lastWidth = width;
         this.lastHeight = height;
         this.updateRenderedLines();
      }
   }

   updateOptions(options: Partial<PagerOptions>): void {
      this.options = {
         ...this.options,
         ...options,
      };
      this.updateRenderedLines();
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
   const config = await getConfig();
   const opts = {
      ...PAGER_DEFAULT_OPTIONS,
      ...{ exitBehavior: config.get<'clearScreen' | 'nextLine'>('viewer.exitBehavior') },
      ...options
   };

   const renderer = new SimplePagerRenderer(content, opts);
   return pagerWithRenderer(renderer, opts);
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
   const config = await getConfig();
   const opts = {
      ...PAGER_DEFAULT_OPTIONS,
      ...{ exitBehavior: config.get<'clearScreen' | 'nextLine'>('viewer.exitBehavior') },
      ...options
   };

   const resolvedRedundancy = opts.redundancyLv ?? 0;

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
   let totalLines = renderer.getLineCount();
   let isRunning = true;
   let actionResult: PagerActionResult | null = null;
   const canUseCopyMode = opts.showLineNumbers;
   const performanceSamples: number[] = [];

   // Hide cursor and clear screen
   process.stdout.write('\x1b[?25l');
   process.stdout.write('\x1b[2J\x1b[H');

   // Disable Logger output while pager is active
   const originalLogLevel = Logger.logLevel;
   Logger.logLevel = -1;

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
            copyModeAvailable: canUseCopyMode,
            redundancyLv: resolvedRedundancy,
         });
         const padding = Math.max(
            0,
            currentWidth - ex_length(stripAnsiColor(statusLine), resolvedRedundancy)
         );
         const bgColor = bgRgb(opts.backgroundColor);
         const dimColor = fgRgb(CATPPUCCIN_VPALETTE.overlay0);
         process.stdout.write(
            '\x1b[K' + bgColor + dimColor + statusLine + ' '.repeat(padding) + SGR.reset
         );
      }
      if (performanceSamples.length > 30) performanceSamples.shift();
      performanceSamples.push(performance.now() - startTime);
   }

   /**
    * Cleans up terminal state, leaving content in scroll buffer.
    */
   function cleanup(): void {
      // Remove event listeners
      process.stdin.off('data', keyHandler);
      process.stdout.off('resize', resizeHandler);

      // Show cursor
      process.stdout.write('\x1b[?25h');

      if (opts.exitBehavior === 'clearScreen') {
         // Clear the screen and move cursor to top-left, remove content from scroll buffer
         process.stdout.write('\x1b[H');
         process.stdout.clearScreenDown();
      }
      else if (opts.exitBehavior === 'nextLine') {
         // Move to bottom of current viewport and add content to scroll buffer
         const currentHeight = getTerminalHeight();
         const linesToAdd = currentHeight - 1;

         // Move cursor to after the displayed content
         process.stdout.write(`\x1b[${linesToAdd}B`);
      }

      process.stdin.setRawMode(false);
      Logger.logLevel = originalLogLevel;
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
         totalLines = renderer.getLineCount();
      }

      render();
   }

   /**
    * Handles keyboard input for navigation.
    * @param key - The key or escape sequence pressed
    */
   function handleKey(key: string): void {
      const currentHeight = getTerminalHeight();
      const visibleCount = currentHeight - 1;
      const maxLine = Math.max(0, renderer.getLineCount() - visibleCount);

      if (key === 'c' && renderer.updateOptions) {
         if (canUseCopyMode) {
            opts.showLineNumbers = !opts.showLineNumbers;
            renderer.updateOptions({ showLineNumbers: opts.showLineNumbers });
            totalLines = renderer.getLineCount();
            const updatedMaxLine = Math.max(0, totalLines - visibleCount);
            currentLine = Math.min(currentLine, updatedMaxLine);
            render();
         }
         return;
      }

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

   const resizeHandler = (): void => handleResize();
   const keyHandler = (chunk: Buffer): void => {
      handleKey(chunk.toString());

      if (!isRunning) {
         cleanup();
      }
   };

   process.stdout.on('resize', resizeHandler);
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
