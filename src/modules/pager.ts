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
import { KeyEvent, LineBuffer, parseInput } from './line-editor';

/** Number of terminal rows occupied by the command palette input box when open. */
const PALETTE_ROWS = 3;
/** Maximum command rows shown in the palette dropdown at once. */
const MAX_COMMAND_ROWS = 8;
/** Inverse-video toggles used to draw the rect text cursor inside the palette input. */
const INVERT_ON = '\x1b[7m';
const INVERT_OFF = '\x1b[27m';
/** How far the selected result's background is mixed toward the foreground color. */
const SELECTED_LINE_BG_MIX = 0.18;

/**
 * A command shown in the pager command palette (the `>` prefix). Commands are
 * filtered by title and run on Enter.
 */
interface PaletteCommand {
   /** Display title, also the fuzzy-search target. */
   title: string;
   /** One-line explanation shown beside the title and in the keybind guide. */
   description: string;
   /** Whether the command is currently applicable; hidden when false. */
   available: () => boolean;
   /** Performs the command. */
   run: () => void;
}

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
   /** Longer explanation shown beside the action in the command palette. */
   description?: string;
   /**
    * When true, the action is surfaced in the footer hint line (subject to the
    * active statusFormat). Non-primary actions are still reachable via the
    * command palette. Default: false.
    */
   primary?: boolean;
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
      // Footer stays minimal: navigate, primary actions, search, quit. Non-primary
      // actions (and copy mode) are discoverable via the command palette / guide.
      const navHintParts = [`${SGR.bright + cyan}↑ ↓${white + SGR.normal} navigate`];
      for (const action of context?.actions ?? []) {
         if (!action.primary) continue;
         const keys = Array.isArray(action.key) ? action.key : [action.key];
         const keyLabel = action.displayKey ?? keys[0] ?? '';
         if (keyLabel) {
            navHintParts.push(`${SGR.bright + cyan}${keyLabel}${white + SGR.normal} ${action.label}`);
         }
      }
      if (context?.searchAvailable) {
         navHintParts.push(`${SGR.bright + cyan}^P${white + SGR.normal} search/menu`);
      }
      navHintParts.push(`${SGR.bright + cyan}q${white + SGR.normal} quit`);
      const navHint = navHintParts.join(`${SGR.dim},${SGR.normal} `);

      const leftParts = [statusText, navHint].filter(Boolean).join(' ');

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
            // Continuation lines get a blank gutter only when line numbers are shown;
            // otherwise it would add lineNumberWidth spurious columns and overflow the row.
            const contGutter = this.options.showLineNumbers
               ? this.formatLineNumber(-1, gutterRPad, gutterBg)
               : '';
            let lastStyles;
            for (let i = 0; i < splitted.length; i++) {
               const g = i === 0 ? gutter : contGutter;

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

   // Start from fresh terminal dimensions and relayout the renderer for them. A
   // stale cache (e.g. a resize since the renderer was built, or a prior pager in
   // a long-lived session) would otherwise make the frame taller/wider than the
   // viewport and scroll the top rows — including the palette — off-screen.
   clearTerminalCache();
   if (renderer.onResize) renderer.onResize(getTerminalWidth(), getTerminalHeight());

   let currentLine = 0;
   let totalLines = renderer.getLineCount();
   let isRunning = true;
   let actionResult: PagerActionResult | null = null;
   const canUseCopyMode = opts.showLineNumbers;
   const performanceSamples: number[] = [];

   // Command palette state. Enabled when the renderer can search; the `>` prefix
   // switches the palette into command mode.
   const searchable = typeof renderer.applySearch === 'function';
   let activeRenderer: PagerRenderer = renderer;
   let paletteState: 'closed' | 'open' | 'browsing' = 'closed';
   const paletteBuffer = new LineBuffer();
   let results: PagerSearchResult[] = [];
   let commandResults: { command: PaletteCommand; titleRanges: number[]; descRanges: number[] }[] =
      [];
   let selectedResult = 0;
   // Horizontal scroll offset of the palette input field viewport.
   let paletteViewOffset = 0;
   // View saved while the "List Keybinds" guide takes over the pager.
   let savedView: { renderer: PagerRenderer; currentLine: number } | null = null;
   // Warm up the fuzzy matcher in the background so the first Ctrl+P is instant.
   if (searchable) void preloadFuzzy();

   // Caller actions are runnable from the palette; primary ones also show in the footer.
   const actionCommands: PaletteCommand[] = (opts.actions ?? []).map((action) => ({
      title: action.label,
      description: action.description ?? '',
      available: () => savedView === null,
      run: () => runAction(action),
   }));

   const commands: PaletteCommand[] = [
      ...actionCommands,
      {
         title: 'List Keybinds',
         description: 'Show keyboard shortcuts and navigation',
         available: () => savedView === null,
         run: () => openHelpPage(),
      },
      {
         title: 'Toggle Copy Mode',
         description: 'Change layout for copying text',
         available: () => canUseCopyMode && savedView === null,
         run: () => toggleCopyMode(),
      },
      {
         title: 'Quit',
         description: 'Exit the pager',
         available: () => true,
         run: () => quitPager(),
      },
   ];

   process.stdout.write('\x1b[?25l');
   // Disable line wrap while painting: each frame row is exactly one screen row, so
   // a row the terminal measures as slightly too wide (e.g. emoji/ambiguous-width
   // characters whose rendered width differs from our estimate) is clipped at the
   // margin instead of wrapping and scrolling the top of the view off-screen.
   process.stdout.write('\x1b[?7l');
   process.stdout.write('\x1b[2J\x1b[H');

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

      // The palette band is the input box plus, in command mode, a dropdown list.
      const paletteRows: string[] = [];
      if (paletteOpen) {
         paletteRows.push(...buildPaletteRows(currentWidth));
         if (paletteMode() === 'command') paletteRows.push(...buildCommandListRows(currentWidth));
      }
      const headerRows = paletteRows.length;

      // activeRenderer.render(start, h, w) yields h-1 viewport lines; the palette
      // band (when open) pushes content down so results are never hidden under it.
      const contentLines = activeRenderer.render(
         currentLine,
         currentHeight - headerRows,
         currentWidth
      );

      const selectedLine =
         paletteState !== 'closed' && paletteMode() === 'search' && results.length > 0
            ? results[Math.min(selectedResult, results.length - 1)]?.line
            : undefined;

      const frame: string[] = [...paletteRows];
      for (let i = 0; i < contentLines.length; i++) {
         const isSelected = selectedLine !== undefined && currentLine + i === selectedLine;
         frame.push(isSelected ? lightenLineBg(contentLines[i]) : contentLines[i]);
      }

      if (opts.showStatus) {
         // The palette and the keybind guide override the footer with their own hints.
         const statusLine = paletteOpen
            ? buildPaletteFooter()
            : savedView
               ? buildHelpFooter()
               : opts.statusFormat(currentLine + 1, totalLines, currentWidth, {
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

      // Never write more rows than the real viewport, so a too-large height can't
      // push the top rows (the palette) off-screen. Read rows directly to defend
      // even against a stale dimension cache.
      const viewportRows = process.stdout.rows || currentHeight;
      const visibleFrame = frame.length > viewportRows ? frame.slice(0, viewportRows) : frame;

      // Compose the whole frame and emit it in a single write. Drawing every row
      // (palette included) in one go removes the gap between clearing the old
      // frame and painting the new one, which is what caused typing to flicker.
      process.stdout.write('\x1b[H' + visibleFrame.map((row) => '\x1b[K' + row).join('\n'));

      if (performanceSamples.length > 30) performanceSamples.shift();
      performanceSamples.push(performance.now() - startTime);
   }

   /**
    * Builds the command palette as {@link PALETTE_ROWS} full-width rows: a centered
    * bordered input box over a popup-colored band that spans the whole terminal.
    */
   function buildPaletteRows(width: number): string[] {
      const raw = paletteBuffer.text;
      const command = paletteMode() === 'command';
      const boxWidth = Math.min(64, Math.max(28, width - 4));
      const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
      const rightPad = Math.max(0, width - boxWidth - leftPad);
      const innerWidth = boxWidth - 2;

      const popupBg = colorMix(CATPPUCCIN_VPALETTE.mantle, CATPPUCCIN_VPALETTE.surface0, 0.6);
      const bg = bgRgb(popupBg);
      const borderFg = fgRgb(CATPPUCCIN_VPALETTE.overlay0);
      const labelFg = fgRgb(CATPPUCCIN_VPALETTE.overlay1);
      const textFg = fgRgb(CATPPUCCIN_VPALETTE.text);
      const dimFg = fgRgb(CATPPUCCIN_VPALETTE.overlay1);

      const label = command
         ? 'cmds '
         : activeRenderer.supportsFileSearch?.()
            ? searchModeFor(raw).mode === 'file'
               ? 'files'
               : 'text '
            : 'find ';
      const total = command ? commandResults.length : results.length;
      const hasQuery = command ? raw.length > 1 : raw.length > 0;
      const count = total ? `${selectedResult + 1}/${total}` : hasQuery ? '0/0' : '';
      const countWidth = count ? count.length + 1 : 0; // trailing space before border

      // Windowed input with an inverse-video rect cursor (matches form.ts): the
      // cursor occupies the cell of its character instead of inserting a glyph, so
      // typing never shifts the text. The viewport keeps the cursor in view.
      const fixedLeft = 1 + 3 + 3; // ' ' + label(7) + ' '(3)
      const fieldWidth = Math.max(1, innerWidth - fixedLeft - countWidth);
      const avail = Math.max(1, fieldWidth - 1); // reserve a cell for the cursor block
      const chars = Array.from(raw);
      const cur = Math.min(paletteBuffer.cursor, chars.length);

      if (cur < paletteViewOffset) paletteViewOffset = cur;
      if (cur > paletteViewOffset + avail) paletteViewOffset = cur - avail;
      if (paletteViewOffset > 0 && chars.length - paletteViewOffset < avail) {
         paletteViewOffset = Math.max(0, chars.length - avail);
      }

      const viewEnd = paletteViewOffset + avail;
      const pre = chars.slice(paletteViewOffset, Math.min(cur, viewEnd)).join('');
      const cursorChar = chars[cur] ?? ' ';
      const post = chars.slice(cur + 1, viewEnd).join('');
      const field = textFg + pre + INVERT_ON + cursorChar + INVERT_OFF + post;
      const fieldVisible = ttys.stringWidth(pre + cursorChar + post);
      const gap = Math.max(0, innerWidth - fixedLeft - fieldVisible - countWidth);

      const midInner =
         ' ' +
         labelFg + label +
         dimFg + ' ' +
         field + bg +
         ' '.repeat(gap) +
         (count ? (total ? dimFg : fgRgb(CATPPUCCIN_VPALETTE.red)) + count + ' ' : '');

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
    * Builds the command-mode dropdown rows shown directly beneath the input box,
    * one per matching command, with the selected row lightened and match
    * characters highlighted.
    */
   function buildCommandListRows(width: number): string[] {
      const boxWidth = Math.min(64, Math.max(28, width - 4));
      const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
      const rightPad = Math.max(0, width - boxWidth - leftPad);

      const popupBg = colorMix(CATPPUCCIN_VPALETTE.mantle, CATPPUCCIN_VPALETTE.surface0, 0.6);
      const selBg = colorMix(popupBg, CATPPUCCIN_VPALETTE.text, SELECTED_LINE_BG_MIX);
      const bgPad = bgRgb(popupBg);
      const padL = bgPad + ' '.repeat(leftPad);
      const padR = bgPad + ' '.repeat(rightPad) + SGR.reset;
      const dimFg = fgRgb(CATPPUCCIN_VPALETTE.overlay1);
      const titleFg = fgRgb(CATPPUCCIN_VPALETTE.text);

      // Pads the already-styled inner to the box width using its visible length.
      const row = (inner: string, innerWidth: number, rowBg: string): string => {
         const pad = Math.max(0, boxWidth - innerWidth);
         return padL + rowBg + inner + ' '.repeat(pad) + padR;
      };

      // A trailing blank popup row gives the dropdown some breathing room above
      // the content beneath it.
      const blank = row('', 0, bgRgb(popupBg));

      if (commandResults.length === 0) {
         const text = ' no matching commands';
         return [row(dimFg + text, text.length, bgRgb(popupBg)), blank];
      }

      const visible = commandResults.slice(0, MAX_COMMAND_ROWS);
      const rows = visible.map(({ command, titleRanges, descRanges }, idx) => {
         const selected = idx === selectedResult;
         const rowBg = bgRgb(selected ? selBg : popupBg);
         const arrow = selected ? fgRgb(CATPPUCCIN_VPALETTE.lavender) + '❯' : ' ';
         // Trim the description (plain text) so the row never overflows the box,
         // then style — avoids slicing through ANSI escapes.
         const fixed = 3 + command.title.length + 1; // ' ' arrow ' ' title ' '
         const maxDesc = Math.max(0, boxWidth - fixed);
         const desc =
            command.description.length > maxDesc
               ? command.description.slice(0, Math.max(0, maxDesc - 1)) + '…'
               : command.description;
         const innerWidth = fixed + desc.length;
         const inner =
            ` ${arrow} ` +
            titleFg +
            highlightMatchRanges(command.title, titleRanges, rowBg) +
            ' ' +
            dimFg +
            highlightMatchRanges(desc, descRanges, rowBg);
         return row(inner, innerWidth, rowBg);
      });
      rows.push(blank);
      return rows;
   }

   /** Formats a single `key label` footer hint. */
   function footerHint(keys: string, label: string): string {
      const cyan = fgRgb(CATPPUCCIN_VPALETTE.cyan);
      const white = fgRgb(CATPPUCCIN_VPALETTE.overlay0);
      return `${SGR.bright + cyan}${keys}${white + SGR.normal} ${label}`;
   }

   /** Builds the palette footer hint line shown while the palette is open. */
   function buildPaletteFooter(): string {
      const action = paletteMode() === 'command' ? footerHint('↵', 'run') : footerHint('↵', 'go to match');
      const parts = [
         footerHint('↑ ↓', 'select'),
         action,
         footerHint('Esc', 'close'),
         footerHint('%', 'search'),
         footerHint('>', 'commands'),
      ];
      return '  ' + parts.join(`${SGR.dim},${SGR.normal} `);
   }

   /** Builds the footer hint line shown while the keybind guide is open. */
   function buildHelpFooter(): string {
      const parts = [footerHint('↑ ↓', 'navigate'), footerHint('Esc', 'back'), footerHint('q', 'quit')];
      return '  ' + parts.join(`${SGR.dim},${SGR.normal} `);
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

      // Show cursor and restore line wrap (disabled during painting).
      process.stdout.write('\x1b[?25h');
      process.stdout.write('\x1b[?7h');

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

      if (activeRenderer.onResize) {
         activeRenderer.onResize(newWidth, newHeight);
         totalLines = activeRenderer.getLineCount();
      }

      // Rebuild palette results against the resized layout so navigation stays accurate.
      if (searchable && paletteState !== 'closed') refreshPalette();

      render();
   }

   /** Whether the palette is in command mode (the `>` prefix). */
   function paletteMode(): 'search' | 'command' {
      return paletteBuffer.text.startsWith('>') ? 'command' : 'search';
   }

   /**
    * Resolves the search mode and bare needle from the raw palette query.
    * A leading `%` forces content search when file search is available;
    * otherwise the default is file search (when supported) or content search.
    */
   function searchModeFor(raw: string): { mode: PagerSearchMode; needle: string } {
      const canFile = activeRenderer.supportsFileSearch?.() ?? false;
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
      const maxLine = Math.max(0, activeRenderer.getLineCount() - visible);
      currentLine = Math.max(0, Math.min(maxLine, target - Math.floor(visible / 2)));
   }

   /** Runs the buffer search for the current query and refreshes navigation state. */
   function runSearch(filtered: boolean): void {
      const { mode, needle } = searchModeFor(paletteBuffer.text);
      results = activeRenderer.applySearch?.(needle, mode, filtered) ?? [];
      totalLines = activeRenderer.getLineCount();
      if (selectedResult >= results.length) selectedResult = Math.max(0, results.length - 1);
      const visible = visibleContentRows();
      currentLine = Math.min(currentLine, Math.max(0, totalLines - visible));
      scrollToSelected();
   }

   /** Number of selectable entries in the active palette mode. */
   function currentResultCount(): number {
      return paletteMode() === 'command' ? commandResults.length : results.length;
   }

   /**
    * Filters the available commands by the given needle. Title matches rank first
    * (with title highlight ranges); commands whose description matches but whose
    * title does not are appended with lower priority (with description highlights).
    */
   function filterCommands(
      needle: string
   ): { command: PaletteCommand; titleRanges: number[]; descRanges: number[] }[] {
      const available = commands.filter((command) => command.available());
      if (!needle) {
         return available.map((command) => ({ command, titleRanges: [], descRanges: [] }));
      }

      const titleMatch = fuzzyMatch(
         available.map((command) => command.title),
         needle
      );
      const matchedTitle = new Set(titleMatch.idx);
      const result: { command: PaletteCommand; titleRanges: number[]; descRanges: number[] }[] =
         titleMatch.idx.map((i, k) => ({
            command: available[i],
            titleRanges: titleMatch.ranges[k],
            descRanges: [],
         }));

      const descMatch = fuzzyMatch(
         available.map((command) => command.description),
         needle
      );
      descMatch.idx.forEach((i, k) => {
         if (matchedTitle.has(i)) return;
         result.push({ command: available[i], titleRanges: [], descRanges: descMatch.ranges[k] });
      });

      return result;
   }

   /** Re-evaluates the palette for the current query (search filter or command list). */
   function refreshPalette(): void {
      if (paletteMode() === 'command') {
         commandResults = filterCommands(paletteBuffer.text.slice(1).trimStart());
         activeRenderer.clearSearch?.();
         results = [];
         totalLines = activeRenderer.getLineCount();
      } else {
         commandResults = [];
         runSearch(true);
      }
      if (selectedResult >= currentResultCount()) {
         selectedResult = Math.max(0, currentResultCount() - 1);
      }
   }

   /** Moves the palette selection by delta and scrolls to it in search mode. */
   function moveSelection(delta: number): void {
      const count = currentResultCount();
      if (count === 0) return;
      selectedResult = Math.max(0, Math.min(count - 1, selectedResult + delta));
      if (paletteMode() === 'search') scrollToSelected();
   }

   /** Handles Enter in the palette: run the selected command, or jump to the match. */
   function onPaletteEnter(): void {
      if (paletteMode() === 'command') {
         const selected = commandResults[selectedResult];
         if (!selected) return;
         selected.command.run();
         if (isRunning) {
            clearSearchAndClose();
            render();
         }
         return;
      }
      // Search mode: stop filtering, keep highlights, jump to the selected match.
      paletteState = 'browsing';
      runSearch(false);
      render();
   }

   /** Opens (or re-opens) the palette, optionally pre-filling the query. */
   async function openPalette(prefill?: string): Promise<void> {
      await preloadFuzzy();
      if (prefill !== undefined) paletteBuffer.setText(prefill);
      selectedResult = 0;
      paletteViewOffset = 0;
      paletteState = 'open';
      refreshPalette();
      render();
   }

   /** Turns off the palette entirely and restores the normal, unfiltered view. */
   function clearSearchAndClose(): void {
      paletteState = 'closed';
      paletteBuffer.setText('');
      results = [];
      commandResults = [];
      selectedResult = 0;
      activeRenderer.clearSearch?.();
      totalLines = activeRenderer.getLineCount();
      const visible = getTerminalHeight() - 1;
      currentLine = Math.min(currentLine, Math.max(0, totalLines - visible));
   }

   /** Toggles copy mode (hides the gutter/line numbers for clean text selection). */
   function toggleCopyMode(): void {
      if (!canUseCopyMode || !activeRenderer.updateOptions) return;
      opts.showLineNumbers = !opts.showLineNumbers;
      activeRenderer.updateOptions({ showLineNumbers: opts.showLineNumbers });
      totalLines = activeRenderer.getLineCount();
      const visible = getTerminalHeight() - 1;
      currentLine = Math.min(currentLine, Math.max(0, totalLines - visible));
   }

   /** Requests pager exit, recording an abort result for interactive sessions. */
   function quitPager(): void {
      if ((opts.actions?.length ?? 0) > 0 && !actionResult) {
         actionResult = { action: 'abort', key: 'q' };
      }
      isRunning = false;
   }

   /** Triggers a caller-defined action, exiting the pager with its result. */
   function runAction(action: PagerAction): void {
      const keys = Array.isArray(action.key) ? action.key : [action.key];
      actionResult = { action: action.action, key: keys[0] ?? '' };
      isRunning = false;
   }

   /** Replaces the view with the keybind guide until the user presses Esc. */
   function openHelpPage(): void {
      savedView = { renderer: activeRenderer, currentLine };
      activeRenderer = new SimplePagerRenderer(buildKeybindGuide(), {
         showLineNumbers: false, // the guide never shows line numbers
         wrapLines: true,
         backgroundColor: opts.backgroundColor,
      });
      currentLine = 0;
      totalLines = activeRenderer.getLineCount();
   }

   /** Restores the view saved before the keybind guide was opened. */
   function closeHelpPage(): void {
      if (!savedView) return;
      activeRenderer = savedView.renderer;
      currentLine = savedView.currentLine;
      savedView = null;
      totalLines = activeRenderer.getLineCount();
   }

   /**
    * Builds the styled keybind guide from the currently available actions.
    * Uses foreground-only styling (no bg / full reset mid-line) so the renderer's
    * background fills each row cleanly.
    */
   function buildKeybindGuide(): string {
      const P = CATPPUCCIN_VPALETTE;
      const keyFg = fgRgb(P.cyan);
      const descFg = fgRgb(P.overlay1);
      const lines: string[] = [
         '',
         `  ${fgRgb(P.lavender)}${SGR.bright}▍ Keyboard Shortcuts & Navigation${SGR.normal}`,
         '',
      ];
      const section = (title: string, rows: [string, string][]): void => {
         lines.push(`  ${fgRgb(P.blue)}${SGR.bright}${title}${SGR.normal}`);
         for (const [keys, desc] of rows) {
            lines.push(`    ${keyFg}${keys.padEnd(24)}${descFg}${desc}`);
         }
         lines.push('');
      };

      section('Navigation', [
         ['↑ / k', 'Scroll up'],
         ['↓ / j', 'Scroll down'],
         ['b / PageUp', 'Page up'],
         ['n / Space / PageDown', 'Page down'],
         ['g / Home', 'Go to top'],
         ['G / End', 'Go to bottom'],
      ]);

      if (searchable) {
         section('Search & Commands', [
            ['Ctrl+P', 'Open the search palette'],
            ['Ctrl+Shift+P', 'Open the command palette'],
            ['>', 'Run a command (in the palette)'],
            ['%', 'Search line content (in the palette)'],
            ['↑ / ↓', 'Select a match or command'],
            ['Enter', 'Jump to match / run command'],
            ['Esc', 'Close the palette'],
         ]);
      }

      if (canUseCopyMode) {
         section('Copy mode', [['c', 'Toggle copy mode (hide gutter for clean copy)']]);
      }

      const actions = opts.actions ?? [];
      if (actions.length > 0) {
         section(
            'Actions',
            actions.map((action) => {
               const keys = Array.isArray(action.key) ? action.key : [action.key];
               return [action.displayKey ?? keys[0] ?? '', action.description || action.label] as [
                  string,
                  string,
               ];
            })
         );
      }

      section('General', [
         ['q / Esc', 'Return from this guide'],
         ['Ctrl+C', 'Quit the pager'],
      ]);

      return lines.join('\n');
   }

   /** Handles a decoded key event while the palette is focused. */
   function handlePaletteEvent(event: KeyEvent): void {
      // Ctrl+P / Ctrl+Shift+P or Esc turn the palette off.
      if (event.name === 'escape' || (event.ctrl && event.name === 'p')) {
         clearSearchAndClose();
         render();
         return;
      }
      if (event.ctrl && event.name === 'c') {
         isRunning = false;
         return;
      }
      if (event.name === 'enter') {
         onPaletteEnter();
         return;
      }
      if (event.name === 'up' || event.name === 'pageup') {
         moveSelection(-1);
         render();
         return;
      }
      if (event.name === 'down' || event.name === 'pagedown') {
         moveSelection(1);
         render();
         return;
      }

      // Everything else is text editing handled by the line buffer (word jumps,
      // Ctrl+Backspace, Home/End, etc.). Re-run the palette only when text changes.
      const before = paletteBuffer.text;
      if (!paletteBuffer.handleKey(event)) return;
      if (paletteBuffer.text !== before) {
         selectedResult = 0;
         refreshPalette();
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
      const maxLine = Math.max(0, activeRenderer.getLineCount() - visibleCount);

      // The keybind guide is a modal overlay: Esc or q returns to the previous
      // view (restoring its scroll position and state); only Ctrl+C hard-quits.
      if (savedView && (key === '\x1b' || key === 'q')) {
         closeHelpPage();
         render();
         return;
      }
      // Esc while browsing search results clears the search and stays in the pager.
      if (searchable && paletteState === 'browsing' && key === '\x1b') {
         clearSearchAndClose();
         render();
         return;
      }

      // Copy mode toggle (disabled while viewing the guide).
      if (key === 'c' && !savedView) {
         toggleCopyMode();
         render();
         return;
      }

      // Caller-defined actions (disabled while viewing the guide).
      const actionBindings = savedView ? [] : opts.actions || [];
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
      const data = chunk.toString();

      // While the palette is focused, route keys through the line-editor parser so
      // editing chords (Ctrl+Backspace, word jumps, Home/End) work as expected.
      if (searchable && paletteState === 'open') {
         for (const event of parseInput(data)) {
            handlePaletteEvent(event);
            if (!isRunning) break;
         }
         if (!isRunning) cleanup();
         return;
      }

      // Ctrl+P opens the search palette; Ctrl+Shift+P opens it in command mode.
      if (searchable) {
         const open = parseInput(data).find((event) => event.ctrl && event.name === 'p');
         if (open) {
            void openPalette(open.shift ? '>' : undefined);
            return;
         }
      }

      handleKey(data);
      if (!isRunning) cleanup();
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
