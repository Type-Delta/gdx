import { ex_length, maxFraction, strJustify } from '@lib/Tools';

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
import ttys from '@/modules/tty-strings';
import { fuzzyMatch, highlightMatchRanges, preloadFuzzy } from './fuzzy-search';

/** Number of terminal rows occupied by the command palette band when open. */
const PALETTE_ROWS = 3;
/** How far the selected result's background is mixed toward the foreground color. */
const SELECTED_LINE_BG_MIX = 0.18;

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
   /** Whether the command palette (Ctrl+P) is available for this content. */
   searchAvailable?: boolean;
   redundancyLv?: number;
}

/** Search mode for the pager command palette. */
export type PagerSearchMode = 'content' | 'file';

/** A single navigable search result (a matched line in the rendered buffer). */
export interface PagerSearchResult {
   /** Rendered-line index to scroll to when this result is selected. */
   line: number;
}

export interface PagerActionResult {
   action: string;
   key: string;
}

export interface PagerOptions {
   /** Number of spaces used to render each tab character. Default: 2 */
   tabWidth?: number;
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
   /**
    * Whether content is separated into files, which enables file-search mode in
    * the command palette. Implement {@link applySearch} to enable the palette.
    */
   supportsFileSearch?: () => boolean;
   /**
    * Applies a search to the content, mutating the rendered output in place.
    * @param query - The plain search needle.
    * @param mode - `'content'` searches line content; `'file'` searches file names/paths.
    * @param filtered - When true, non-matching content lines are hidden (live palette);
    *   when false, all lines are shown with matches highlighted (browsing after Enter).
    * @returns Navigable results in document order; empty when there is no query or no match.
    */
   applySearch?: (query: string, mode: PagerSearchMode, filtered: boolean) => PagerSearchResult[];
   /** Clears any active search filter/highlight and restores normal rendering. */
   clearSearch?: () => void;
}

/** Default pager configuration */
export const PAGER_DEFAULT_OPTIONS: Omit<Required<PagerOptions>, 'redundancyLv'> = {
   tabWidth: 2,
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
      if (context?.searchAvailable) {
         navHintParts.push(`${SGR.bright + cyan}^P${white + SGR.normal} search`);
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
         ttys.stringJustify(
            [leftParts, locationInfo],
            termWidth - 4, // Subtract 4 to account for the leading spaces and trailing spaces
            {
               align: 'spacebetween',
               filler: ' ',
               overflow: 'collapse',
               collapseLocation: 'mid',
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
   /** Active search state, or null when no search is applied. */
   private search: { matches: Map<number, number[]>; filtered: boolean } | null = null;
   /** Rendered-line index where each logical line begins (-1 when filtered out). */
   private lineRenderStart: number[] = [];

   constructor(content: string, options: PagerOptions = {}) {
      this.options = {
         ...PAGER_DEFAULT_OPTIONS,
         ...options,
      } as Required<PagerOptions>;
      this.lines = expandTabs(content, this.options.tabWidth).split('\n');
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
      this.lineRenderStart = new Array(this.lines.length).fill(-1);

      for (let i = 0; i < this.lines.length; i++) {
         const matchRanges = this.search?.matches.get(i);
         if (this.search?.filtered && matchRanges === undefined) continue;

         this.lineRenderStart[i] = this.renderedLines.length;
         const line = matchRanges
            ? highlightMatchRanges(this.lines[i], matchRanges, contentBg)
            : this.lines[i];

         if (this.options.wrapLines && ttys.stringWidth(line) > contentWidth) {
            const wrapped = ttys.stringWrap(line, contentWidth, {
               mode: 'strict',
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

   supportsFileSearch(): boolean {
      // ponytail: plain content has no file structure, so only content search applies.
      return false;
   }

   applySearch(query: string, _mode: PagerSearchMode, filtered: boolean): PagerSearchResult[] {
      if (!query) {
         this.clearSearch();
         return [];
      }

      const { idx, ranges } = fuzzyMatch(this.lines, query);
      const matches = new Map<number, number[]>();
      idx.forEach((lineIndex, k) => matches.set(lineIndex, ranges[k]));
      this.search = { matches, filtered };
      this.updateRenderedLines();

      const results: PagerSearchResult[] = [];
      for (const lineIndex of idx) {
         const start = this.lineRenderStart[lineIndex];
         if (start >= 0) results.push({ line: start });
      }
      return results;
   }

   clearSearch(): void {
      if (!this.search) return;
      this.search = null;
      this.updateRenderedLines();
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
            const padding = Math.max(0, width - ttys.stringWidth(stripped));
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
 * Replaces tabs with a fixed number of spaces so terminal width calculations
 * operate on the same characters that will be rendered.
 * @param content - Text that may contain tab characters.
 * @param tabWidth - Number of spaces used for each tab.
 * @returns Content with every tab replaced by spaces.
 */
export function expandTabs(content: string, tabWidth: number): string {
   return content.replace(/\t/g, ' '.repeat(tabWidth));
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
      ...{
         exitBehavior: config.get<'clearScreen' | 'nextLine'>('viewer.exitBehavior'),
         tabWidth: config.get<number>('viewer.tabWidth', PAGER_DEFAULT_OPTIONS.tabWidth),
      },
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
      ...{
         exitBehavior: config.get<'clearScreen' | 'nextLine'>('viewer.exitBehavior'),
         tabWidth: config.get<number>('viewer.tabWidth', PAGER_DEFAULT_OPTIONS.tabWidth),
      },
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

   // Command palette (Ctrl+P) state. Enabled when the renderer can search.
   const searchable = typeof renderer.applySearch === 'function';
   let paletteState: 'closed' | 'open' | 'browsing' = 'closed';
   let query = '';
   let results: PagerSearchResult[] = [];
   let selectedResult = 0;
   // Warm up the fuzzy matcher in the background so the first Ctrl+P is instant.
   if (searchable) void preloadFuzzy();

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
      const paletteOpen = searchable && paletteState === 'open';
      const headerRows = paletteOpen ? PALETTE_ROWS : 0;

      // renderer.render(start, h, w) yields h-1 viewport lines; the palette band
      // (when open) pushes content down so results are never hidden under it.
      const contentLines = renderer.render(
         currentLine,
         currentHeight - headerRows,
         currentWidth
      );

      const selectedLine =
         results.length > 0 && paletteState !== 'closed'
            ? results[Math.min(selectedResult, results.length - 1)]?.line
            : undefined;

      const frame: string[] = [];
      if (paletteOpen) frame.push(...buildPaletteRows(currentWidth));
      for (let i = 0; i < contentLines.length; i++) {
         const isSelected = selectedLine !== undefined && currentLine + i === selectedLine;
         frame.push(isSelected ? lightenLineBg(contentLines[i]) : contentLines[i]);
      }

      if (opts.showStatus) {
         const statusLine = opts.statusFormat(currentLine + 1, totalLines, currentWidth, {
            statusText: opts.statusText,
            actions: opts.actions,
            copyModeAvailable: canUseCopyMode,
            searchAvailable: searchable,
            redundancyLv: resolvedRedundancy,
         });
         const padding = Math.max(0, currentWidth - ttys.stringWidth(statusLine));
         const bgColor = bgRgb(opts.backgroundColor);
         const dimColor = fgRgb(CATPPUCCIN_VPALETTE.overlay0);
         frame.push(bgColor + dimColor + statusLine + ' '.repeat(padding) + SGR.reset);
      }

      // Compose the whole frame and emit it in a single write. Drawing every row
      // (palette included) in one go removes the gap between clearing the old
      // frame and painting the new one, which is what caused typing to flicker.
      process.stdout.write('\x1b[H' + frame.map((row) => '\x1b[K' + row).join('\n'));

      if (performanceSamples.length > 30) performanceSamples.shift();
      performanceSamples.push(performance.now() - startTime);
   }

   /**
    * Builds the command palette as {@link PALETTE_ROWS} full-width rows: a centered
    * bordered input box over a popup-colored band that spans the whole terminal.
    */
   function buildPaletteRows(width: number): string[] {
      const { mode } = searchModeFor(query);
      const boxWidth = Math.min(64, Math.max(28, width - 4));
      const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
      const rightPad = Math.max(0, width - boxWidth - leftPad);
      const innerWidth = boxWidth - 2;

      const popupBg = colorMix(CATPPUCCIN_VPALETTE.mantle, CATPPUCCIN_VPALETTE.surface0, 0.6);
      const bg = bgRgb(popupBg);
      const borderFg = fgRgb(CATPPUCCIN_VPALETTE.overlay0);
      const labelFg = fgRgb(CATPPUCCIN_VPALETTE.cyan);
      const textFg = fgRgb(CATPPUCCIN_VPALETTE.text);
      const dimFg = fgRgb(CATPPUCCIN_VPALETTE.overlay1);

      const label = renderer.supportsFileSearch?.()
         ? mode === 'file'
            ? 'files'
            : 'text '
         : 'find ';
      const count = results.length
         ? `${selectedResult + 1}/${results.length}`
         : query
            ? '0/0'
            : '';
      const countWidth = count ? count.length + 1 : 0; // trailing space before border

      // fixed left parts: ' '(1) + label(5) + ' ❯ '(3) + query + cursor(1)
      const fixedLeft = 1 + 5 + 3 + 1;
      const queryBudget = Math.max(1, innerWidth - fixedLeft - countWidth);
      // Keep the tail (nearest the cursor) visible and clamp by display width so a
      // wide-character query can't overflow the box and wrap onto a fourth row.
      const q =
         ttys.stringWidth(query) > queryBudget
            ? ttys.stringLimit(query, queryBudget, 'start')
            : query;
      const gap = Math.max(0, innerWidth - fixedLeft - ttys.stringWidth(q) - countWidth);

      const midInner =
         ' ' +
         labelFg + label +
         dimFg + ' ❯ ' +
         textFg + q + SGR.bright + '▏' + SGR.normal + bg +
         ' '.repeat(gap) +
         dimFg + (count && !(query && results.length) ? SGR.red : '') + (count ? count + ' ' : '');

      const padL = bg + ' '.repeat(leftPad);
      const padR = bg + ' '.repeat(rightPad) + SGR.reset;
      const border = bg + borderFg;
      return [
         padL + border + '╭' + '─'.repeat(innerWidth) + '╮' + padR,
         padL + border + '│' + midInner + border + '│' + padR,
         padL + border + '╰' + '─'.repeat(innerWidth) + '╯' + padR,
      ];
   }

   /**
    * Lightens every truecolor background in a rendered line so the currently
    * selected search result stands out from the surrounding content.
    */
   function lightenLineBg(line: string): string {
      return line.replace(
         /\x1b\[48;2;(\d+);(\d+);(\d+)m/g,
         (_full, r: string, g: string, b: string) =>
            bgRgb(
               colorMix(
                  [Number(r), Number(g), Number(b)] as RgbVec,
                  CATPPUCCIN_VPALETTE.text,
                  SELECTED_LINE_BG_MIX
               )
            )
      );
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

      // Rebuild search results against the resized layout so navigation stays accurate.
      if (searchable && paletteState !== 'closed') runSearch(paletteState === 'open');

      render();
   }

   /**
    * Resolves the search mode and bare needle from the raw palette query.
    * A leading `%` forces content search when file search is available;
    * otherwise the default is file search (when supported) or content search.
    */
   function searchModeFor(raw: string): { mode: PagerSearchMode; needle: string } {
      const canFile = renderer.supportsFileSearch?.() ?? false;
      if (canFile && raw.startsWith('%')) return { mode: 'content', needle: raw.slice(1) };
      if (canFile) return { mode: 'file', needle: raw };
      return { mode: 'content', needle: raw };
   }

   /** Number of content rows visible, accounting for the palette band and status bar. */
   function visibleContentRows(): number {
      return getTerminalHeight() - (paletteState === 'open' ? PALETTE_ROWS : 0) - 1;
   }

   /** Scrolls the viewport so the currently selected result is centered. */
   function scrollToSelected(): void {
      if (results.length === 0) return;
      const visible = visibleContentRows();
      const target = results[Math.min(selectedResult, results.length - 1)]?.line ?? 0;
      const maxLine = Math.max(0, renderer.getLineCount() - visible);
      currentLine = Math.max(0, Math.min(maxLine, target - Math.floor(visible / 2)));
   }

   /** Runs the current query against the renderer and refreshes navigation state. */
   function runSearch(filtered: boolean): void {
      const { mode, needle } = searchModeFor(query);
      results = renderer.applySearch?.(needle, mode, filtered) ?? [];
      totalLines = renderer.getLineCount();
      if (selectedResult >= results.length) selectedResult = Math.max(0, results.length - 1);
      const visible = visibleContentRows();
      currentLine = Math.min(currentLine, Math.max(0, totalLines - visible));
      scrollToSelected();
   }

   /** Opens (or re-opens) the palette in live-filter mode, preserving the query. */
   async function openPalette(): Promise<void> {
      await preloadFuzzy();
      paletteState = 'open';
      runSearch(true);
      render();
   }

   /** Turns off search entirely and restores the normal, unfiltered view. */
   function clearSearchAndClose(): void {
      paletteState = 'closed';
      query = '';
      results = [];
      selectedResult = 0;
      renderer.clearSearch?.();
      totalLines = renderer.getLineCount();
      const visible = getTerminalHeight() - 1;
      currentLine = Math.min(currentLine, Math.max(0, totalLines - visible));
   }

   /** Whether a key chunk is printable text that should be appended to the query. */
   function isPrintableInput(key: string): boolean {
      return key.length > 0 && key[0] >= ' ' && key[0] !== '\x7f' && !key.startsWith('\x1b');
   }

   /** Handles keyboard input while the palette is focused. */
   function handlePaletteKey(key: string): void {
      switch (key) {
         case '\x10': // Ctrl+P
         case '\x1b': // Esc -> turn off search/filter
            clearSearchAndClose();
            render();
            return;
         case '\x03': // Ctrl+C -> quit pager
            isRunning = false;
            return;
         case '\r':
         case '\n': // Enter -> browse: unfilter, keep highlights, jump to selection
            paletteState = 'browsing';
            runSearch(false);
            render();
            return;
         case '\x7f':
         case '\b': // Backspace
            query = query.slice(0, -1);
            selectedResult = 0;
            runSearch(true);
            render();
            return;
         case '\x1b[A': // Up
         case '\x1b[5~': // Page Up
            selectedResult = Math.max(0, selectedResult - 1);
            scrollToSelected();
            render();
            return;
         case '\x1b[B': // Down
         case '\x1b[6~': // Page Down
            selectedResult = Math.min(Math.max(0, results.length - 1), selectedResult + 1);
            scrollToSelected();
            render();
            return;
      }

      if (isPrintableInput(key)) {
         query += key;
         selectedResult = 0;
         runSearch(true);
         render();
      }
   }

   /**
    * Handles keyboard input for navigation.
    * @param key - The key or escape sequence pressed
    */
   function handleKey(key: string): void {
      const currentHeight = getTerminalHeight();
      const visibleCount = currentHeight - 1;
      const maxLine = Math.max(0, renderer.getLineCount() - visibleCount);

      // Command palette routing.
      if (searchable && paletteState === 'open') {
         handlePaletteKey(key);
         return;
      }
      if (searchable && key === '\x10') {
         // Ctrl+P opens from normal view, or re-opens from browsing to change filtering.
         void openPalette();
         return;
      }
      if (searchable && paletteState === 'browsing' && key === '\x1b') {
         // Esc while browsing results clears the search and stays in the pager.
         clearSearchAndClose();
         render();
         return;
      }

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
