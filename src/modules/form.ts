import { Err } from '@lib/Tools';

import ttys from '@/modules/tty-strings';
import { CATPPUCCIN_VPALETTE, SGR } from '@/consts';
import { bgRgb, fgRgb, RgbVec } from './graphics';
import { clearTerminalCache, getTerminalHeight, getTerminalWidth } from './pager';
import { KeyEvent, LineBuffer, parseInput } from './line-editor';
import Logger from '@/utils/logger';

/** Value types a form question can resolve to. */
export type FormAnswerValue = string | boolean | null;

/** Answers keyed by question key; null means the question was skipped. */
export type FormAnswers = Record<string, FormAnswerValue>;

/** Result returned by `Form.run()`. */
export interface FormResult {
   /** True when every question was answered/skipped; false on early exit (Esc / Ctrl+C). */
   completed: boolean;
   /** Collected answers (partial when `completed` is false). */
   answers: FormAnswers;
}

/** Options shared by all question types. */
interface FormQuestionOptions {
   /** Secondary help text rendered under the question title. */
   description?: string;
   /** Optional questions can be skipped with Tab (textbox: empty Enter also skips). */
   optional?: boolean;
}

/** Options for textbox questions. */
export interface FormTextboxOptions extends FormQuestionOptions {
   /** Dimmed hint text shown while the textbox is empty. */
   placeholder?: string;
   /** Pre-filled editable value. */
   initial?: string;
}

/** Options for dropdown questions. */
export interface FormDropdownOptions extends FormQuestionOptions {
   /** Dimmed hint text shown while the filter is empty. */
   placeholder?: string;
}

/** Options for choice questions. */
export interface FormChoiceOptions extends FormQuestionOptions {
   /** Option selected initially (defaults to the first option). */
   initial?: string;
}

/** A call-to-action button in a confirm question. */
export interface FormConfirmAction {
   /** Button label. */
   label: string;
   /** Value stored as the answer when this button is activated. */
   value: FormAnswerValue;
}

/** Options for confirm questions. */
export interface FormConfirmOptions extends FormQuestionOptions {
   /** Extra content lines (e.g. a settings summary) rendered above the buttons. */
   body?: string[];
   /** Call-to-action buttons; defaults to Confirm (true) / Cancel (false). */
   actions?: FormConfirmAction[];
}

interface FormQuestion {
   key: string;
   type: 'textbox' | 'dropdown' | 'choice' | 'confirm';
   title: string;
   description?: string;
   optional?: boolean;
   placeholder?: string;
   initial?: string;
   options?: string[];
   body?: string[];
   actions?: FormConfirmAction[];
}

/** Per-question runtime state, kept across back-navigation. */
interface QuestionState {
   /** Textbox content or dropdown filter text. */
   buffer: LineBuffer;
   /** Selected index for dropdown/choice/confirm widgets. */
   selection: number;
   /** Horizontal scroll offset of the input field viewport. */
   viewOffset: number;
}

const P = CATPPUCCIN_VPALETTE;
/** Inverse-video toggles used to draw the text cursor inside fields. */
const INVERT_ON = '\x1b[7m';
const INVERT_OFF = '\x1b[27m';

/**
 * Pads a line with a background color to fill the full terminal width.
 * The background is re-applied after the content so embedded SGR resets
 * don't leak default colors into the padding.
 * @param content - Line content (may contain ANSI codes).
 * @param width - Target visual width.
 * @param bg - Background color.
 * @returns The padded line ending with a full SGR reset.
 */
function padBg(content: string, width: number, bg: RgbVec): string {
   const padding = Math.max(0, width - ttys.stringWidth(content));
   return bgRgb(bg) + content + bgRgb(bg) + ' '.repeat(padding) + SGR.reset;
}

/**
 * Full-screen TUI form themed with Catppuccin Mocha.
 *
 * Questions are added through builder chaining and presented one at a time,
 * vertically centered between the header and footer bands. A progress
 * indicator (colored dots for fewer than 3 questions, a progress bar
 * otherwise) sits on a fixed row below the question block, or in the footer
 * when `progressPosition: 'footer'` is set or vertical space runs out. The
 * form occupies the whole terminal (like the pager) and restores the screen
 * on exit.
 *
 * Key bindings: Enter confirms; Shift+Right (Shift+→) skips optional questions or
 * re-advances past answered ones; Shift+Left (Shift+←) goes back; Esc / Ctrl+C
 * exits early. Tab and Shift+Tab work as undocumented aliases for Shift+→ / Shift+←.
 *
 * @example
 * const result = await new Form({ title: 'Create repository' })
 *    .textbox('name', 'Repository name')
 *    .choice('visibility', 'Visibility', ['private', 'public'], { initial: 'private' })
 *    .confirm('proceed', 'Create repository?')
 *    .run();
 */
export class Form {
   private readonly title: string;
   private readonly progressPosition: 'inline' | 'footer';
   private readonly questions: FormQuestion[] = [];
   private readonly answers: FormAnswers = {};
   private readonly states = new Map<number, QuestionState>();
   private index = 0;
   private error: string | null = null;
   private isRunning = false;
   private completed = false;

   constructor(options: { title?: string; progressPosition?: 'inline' | 'footer' } = {}) {
      this.title = options.title ?? 'Form';
      this.progressPosition = options.progressPosition ?? 'inline';
   }

   /**
    * Adds a free-text question.
    * @param key - Answer key.
    * @param title - Question title.
    * @param options - Textbox options.
    * @returns This form for chaining.
    */
   textbox(key: string, title: string, options: FormTextboxOptions = {}): this {
      this.questions.push({ key, type: 'textbox', title, ...options });
      return this;
   }

   /**
    * Adds a filterable selection question. The list cannot be expanded by
    * clicking; typing filters the options instead.
    * @param key - Answer key.
    * @param title - Question title.
    * @param options - Selectable values.
    * @param extra - Dropdown options.
    * @returns This form for chaining.
    */
   dropdown(key: string, title: string, options: string[], extra: FormDropdownOptions = {}): this {
      this.questions.push({ key, type: 'dropdown', title, options, ...extra });
      return this;
   }

   /**
    * Adds a segmented-pill selection question where every option is visible.
    * @param key - Answer key.
    * @param title - Question title.
    * @param options - Selectable values displayed as pill segments.
    * @param extra - Choice options.
    * @returns This form for chaining.
    */
   choice(key: string, title: string, options: string[], extra: FormChoiceOptions = {}): this {
      this.questions.push({ key, type: 'choice', title, options, ...extra });
      return this;
   }

   /**
    * Adds a confirmation dialog with customizable call-to-action buttons.
    * @param key - Answer key.
    * @param title - Question title.
    * @param options - Confirm options (body lines and CTA buttons).
    * @returns This form for chaining.
    */
   confirm(key: string, title: string, options: FormConfirmOptions = {}): this {
      this.questions.push({
         key,
         type: 'confirm',
         title,
         actions: options.actions ?? [
            { label: 'Confirm', value: true },
            { label: 'Cancel', value: false },
         ],
         ...options,
      });
      return this;
   }

   /**
    * Runs the form interactively and resolves once it completes or is exited.
    * @returns The collected answers and a completion flag.
    * @throws {Err} FORM_EMPTY when no questions were added.
    * @throws {Err} FORM_UNSUPPORTED when stdin/stdout is not an interactive TTY.
    */
   async run(): Promise<FormResult> {
      if (this.questions.length === 0) {
         throw new Err('Form has no questions to display.', 'FORM_EMPTY');
      }
      if (!process.stdout.isTTY || !process.stdin.isTTY) {
         throw new Err('Form requires an interactive terminal.', 'FORM_UNSUPPORTED');
      }

      const stdin = process.stdin;
      const stdout = process.stdout;
      const wasRaw = stdin.isRaw === true;

      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf-8');

      // Hide cursor and clear screen (cursor is drawn manually inside fields)
      stdout.write('\x1b[?25l\x1b[2J\x1b[H');

      // Disable Logger output while the form is active (same as pager)
      const originalLogLevel = Logger.logLevel;
      Logger.logLevel = -1;

      this.isRunning = true;
      this.completed = false;
      this.index = 0;
      this.error = null;

      return new Promise<FormResult>((resolve) => {
         const cleanup = (): void => {
            stdin.off('data', keyHandler);
            stdout.off('resize', resizeHandler);
            // Restore screen: clear form content and show cursor
            stdout.write('\x1b[H');
            stdout.clearScreenDown();
            stdout.write('\x1b[?25h');
            stdin.setRawMode(wasRaw);
            stdin.pause();
            Logger.logLevel = originalLogLevel;
         };

         const keyHandler = (data: string): void => {
            for (const event of parseInput(data)) {
               this.handleKey(event);
               if (!this.isRunning) break;
            }
            if (!this.isRunning) {
               cleanup();
               resolve({ completed: this.completed, answers: { ...this.answers } });
               return;
            }
            this.render();
         };

         const resizeHandler = (): void => {
            clearTerminalCache();
            this.render();
         };

         stdin.on('data', keyHandler);
         stdout.on('resize', resizeHandler);

         this.render();
      });
   }

   /**
    * Lazily creates the runtime state for a question index.
    * @param index - Question index.
    * @returns The question state.
    */
   private getState(index: number): QuestionState {
      let state = this.states.get(index);
      if (state) return state;

      const question = this.questions[index];
      let selection = 0;
      if (question.type === 'choice' && question.initial && question.options) {
         selection = Math.max(0, question.options.indexOf(question.initial));
      }
      state = {
         buffer: new LineBuffer(question.type === 'textbox' ? question.initial ?? '' : ''),
         selection,
         viewOffset: 0,
      };
      this.states.set(index, state);
      return state;
   }

   /**
    * Filters dropdown options by the typed filter text (case-insensitive).
    * @param question - Dropdown question.
    * @param state - Question state holding the filter buffer.
    * @returns The filtered option list.
    */
   private filterOptions(question: FormQuestion, state: QuestionState): string[] {
      const filter = state.buffer.text.trim().toLowerCase();
      const options = question.options ?? [];
      if (!filter) return options;
      return options.filter((option) => option.toLowerCase().includes(filter));
   }

   /**
    * Stores an answer for the current question and advances the form.
    * @param key - Answer key.
    * @param value - Answer value (null when skipped).
    */
   private commit(key: string, value: FormAnswerValue): void {
      this.answers[key] = value;
      this.error = null;
      this.index++;
      if (this.index >= this.questions.length) {
         this.completed = true;
         this.isRunning = false;
      }
   }

   /**
    * Moves forward without committing new input: re-advances past an already
    * answered question, skips an optional unanswered one, and reports an
    * error on a required unanswered one.
    * @param question - The current question.
    */
   private forward(question: FormQuestion): void {
      if (question.key in this.answers) {
         this.index++;
         if (this.index >= this.questions.length) {
            this.completed = true;
            this.isRunning = false;
         }
         return;
      }
      if (question.optional) {
         this.commit(question.key, null);
         return;
      }
      this.error = 'This question is required.';
   }

   /**
    * Applies a key event to the current question.
    * @param event - Decoded key event.
    */
   private handleKey(event: KeyEvent): void {
      this.error = null;

      if ((event.ctrl && event.name === 'c') || event.name === 'escape') {
         this.isRunning = false;
         return;
      }

      const question = this.questions[this.index];
      const state = this.getState(this.index);

      // Shift+Left goes back, Shift+Right skips/advances (Tab and Shift+Tab
      // are kept as undocumented aliases)
      if (event.shift && (event.name === 'left' || event.name === 'tab')) {
         if (this.index > 0) this.index--;
         return;
      }
      if ((event.shift && event.name === 'right') || event.name === 'tab') {
         this.forward(question);
         return;
      }

      switch (question.type) {
         case 'textbox': {
            if (event.name === 'enter') {
               const value = state.buffer.text.trim();
               if (!value && !question.optional) {
                  this.error = 'This field is required.';
                  return;
               }
               this.commit(question.key, value || null);
               return;
            }
            state.buffer.handleKey(event);
            return;
         }
         case 'dropdown': {
            const filtered = this.filterOptions(question, state);
            state.selection = Math.min(state.selection, Math.max(0, filtered.length - 1));

            if (event.name === 'up') {
               state.selection = Math.max(0, state.selection - 1);
               return;
            }
            if (event.name === 'down') {
               state.selection = Math.min(Math.max(0, filtered.length - 1), state.selection + 1);
               return;
            }
            if (event.name === 'enter') {
               const selected = filtered[state.selection];
               if (selected !== undefined) {
                  this.commit(question.key, selected);
                  return;
               }
               if (question.optional && !state.buffer.text.trim()) {
                  this.commit(question.key, null);
                  return;
               }
               this.error = question.optional
                  ? 'No matching option. Adjust the filter or press Shift+→ to skip.'
                  : 'No matching option. Adjust the filter to select one.';
               return;
            }
            if (state.buffer.handleKey(event)) state.selection = 0;
            return;
         }
         case 'choice': {
            const options = question.options ?? [];
            if (event.name === 'left' || event.name === 'up') {
               state.selection = (state.selection - 1 + options.length) % options.length;
               return;
            }
            if (event.name === 'right' || event.name === 'down') {
               state.selection = (state.selection + 1) % options.length;
               return;
            }
            if (event.name === 'enter' && options.length > 0) {
               this.commit(question.key, options[state.selection]);
            }
            return;
         }
         case 'confirm': {
            const actions = question.actions ?? [];
            if (event.name === 'left' || event.name === 'up') {
               state.selection = (state.selection - 1 + actions.length) % actions.length;
               return;
            }
            if (event.name === 'right' || event.name === 'down') {
               state.selection = (state.selection + 1) % actions.length;
               return;
            }
            if (event.name === 'enter' && actions.length > 0) {
               this.commit(question.key, actions[state.selection].value);
            }
            return;
         }
      }
   }

   /** Writes the current screen content to stdout. */
   private render(): void {
      const height = getTerminalHeight();
      const lines = this.renderScreen();

      process.stdout.write('\x1b[H');
      for (let i = 0; i < height - 1; i++) {
         process.stdout.write('\x1b[K' + (lines[i] ?? '') + '\n');
      }
      process.stdout.write('\x1b[K' + (lines[height - 1] ?? ''));
   }

   /**
    * Builds the full-screen line array for the current question.
    *
    * Layout: header band at the top, footer band at the bottom, and the
    * question block vertically centered in between. With inline progress,
    * the indicator sits on a fixed row above the footer so it does not move
    * when the widget grows or shrinks; when disabled or out of space, the
    * progress falls back to the footer band.
    *
    * @returns Exactly `terminal height` rendered lines.
    */
   private renderScreen(): string[] {
      const width = getTerminalWidth();
      const height = getTerminalHeight();
      const question = this.questions[this.index];
      const state = this.getState(this.index);
      const blank = (): string => padBg('', width, P.base);

      const header = [
         padBg('', width, P.mantle),
         padBg(
            `  ${fgRgb(P.lavender)}${SGR.bright}▍ ${this.title}${SGR.normal}` +
            `   ${fgRgb(P.overlay0)}${SGR.dim}${this.index + 1} of ${this.questions.length}${SGR.normal}`,
            width,
            P.mantle
         ),
         padBg('', width, P.mantle),
      ];

      // Region sizes between header and footer for both progress placements:
      // inline reserves 3 extra rows (gap, progress, gap) above the footer.
      const inlineRegion = height - header.length - 4;
      const footerRegion = height - header.length - 2;

      let content = this.renderContent(question, state, width, inlineRegion);
      const inlineProgress =
         this.progressPosition === 'inline' && inlineRegion >= 5 && content.length <= inlineRegion;
      const region = inlineProgress ? inlineRegion : footerRegion;
      if (!inlineProgress) content = this.renderContent(question, state, width, footerRegion);

      const lines: string[] = [...header];

      // Vertically center the question block within the region
      const padTop = Math.max(0, Math.floor((region - content.length) / 2));
      for (let i = 0; i < padTop; i++) lines.push(blank());
      lines.push(...content.slice(0, region));
      while (lines.length < header.length + region) lines.push(blank());

      if (inlineProgress) {
         lines.push(blank());
         const progress = this.renderProgress();
         const left = Math.max(0, Math.floor((width - ttys.stringWidth(progress)) / 2));
         lines.push(padBg(' '.repeat(left) + progress, width, P.base));
         lines.push(blank());
      } else {
         lines.push(blank());
      }

      lines.push(this.renderFooter(question, width, !inlineProgress));
      return lines;
   }

   /**
    * Renders the centered question block: title, description, widget, and a
    * reserved error row (kept blank when there is no error so the block height
    * stays stable while typing).
    * @param question - Question to render.
    * @param state - Question runtime state.
    * @param width - Terminal width.
    * @param region - Rows available for the block.
    * @returns Rendered block lines.
    */
   private renderContent(
      question: FormQuestion,
      state: QuestionState,
      width: number,
      region: number
   ): string[] {
      const lines: string[] = [];
      const blank = (): string => padBg('', width, P.base);

      // Center the block horizontally: indent everything to where the
      // (width-capped) input block starts, keeping internals left-aligned
      const blockWidth = Math.max(16, Math.min(64, width - 8));
      const margin = ' '.repeat(Math.max(3, Math.floor((width - blockWidth) / 2)));

      // Question title and optional/required marker
      const marker = question.optional
         ? `  ${fgRgb(P.overlay0)}${SGR.italic}optional${SGR.reset}`
         : ` ${fgRgb(P.red)}*`;
      lines.push(
         padBg(`${margin}${fgRgb(P.text)}${SGR.bright}${question.title}${SGR.normal}${marker}`, width, P.base)
      );

      if (question.description) {
         const wrapped = ttys.stringWrap(question.description, Math.max(20, blockWidth));
         for (const line of wrapped.split('\n')) {
            lines.push(padBg(`${margin}${fgRgb(P.overlay1)}${line}`, width, P.base));
         }
      }
      lines.push(blank());

      // Widget gets the remaining rows minus the reserved error slot
      const widgetBudget = Math.max(3, region - lines.length - 2);
      lines.push(...this.renderWidget(question, state, width, widgetBudget, margin));

      // Reserved error slot
      lines.push(blank());
      lines.push(
         this.error ? padBg(`${margin}${fgRgb(P.red)}✗ ${this.error}`, width, P.base) : blank()
      );

      return lines;
   }

   /**
    * Renders the interactive widget for a question.
    * @param question - Question to render.
    * @param state - Question runtime state.
    * @param width - Terminal width.
    * @param budget - Maximum rows the widget may occupy.
    * @param margin - Left margin that horizontally centers the block.
    * @returns Rendered widget lines.
    */
   private renderWidget(
      question: FormQuestion,
      state: QuestionState,
      width: number,
      budget: number,
      margin: string
   ): string[] {
      switch (question.type) {
         case 'textbox':
            return this.renderInputField(question, state, width, margin);
         case 'dropdown': {
            const lines = this.renderInputField(question, state, width, margin);
            lines.push(
               ...this.renderDropdownList(question, state, width, budget - lines.length, margin)
            );
            return lines;
         }
         case 'choice':
            return [this.renderSegments(question.options ?? [], state.selection, width, margin)];
         case 'confirm': {
            const lines: string[] = [];
            const bodyBudget = Math.max(0, budget - 2);
            const body = question.body ?? [];
            for (const bodyLine of body.slice(0, bodyBudget)) {
               lines.push(padBg(`${margin}${fgRgb(P.text)}${bodyLine}`, width, P.base));
            }
            if (body.length > 0) lines.push(padBg('', width, P.base));
            lines.push(
               this.renderSegments(
                  (question.actions ?? []).map((action) => action.label),
                  state.selection,
                  width,
                  margin
               )
            );
            return lines;
         }
      }
   }

   /**
    * Renders a bordered single-line input field with a manually drawn cursor.
    * Used by textbox questions and as the dropdown filter field.
    * @param question - Owning question (for placeholder text).
    * @param state - Question state holding the buffer and viewport offset.
    * @param width - Terminal width.
    * @param margin - Left margin that horizontally centers the block.
    * @returns Three lines: top border, content, bottom border.
    */
   private renderInputField(
      question: FormQuestion,
      state: QuestionState,
      width: number,
      margin: string
   ): string[] {
      const fieldWidth = Math.max(16, Math.min(64, width - 8));
      const inner = fieldWidth - 4;
      const avail = inner - 1; // last cell is reserved for the cursor block
      const buffer = state.buffer;

      if (buffer.cursor < state.viewOffset) state.viewOffset = buffer.cursor;
      if (buffer.cursor > state.viewOffset + avail) state.viewOffset = buffer.cursor - avail;
      if (state.viewOffset > 0 && buffer.length - state.viewOffset < avail) {
         state.viewOffset = Math.max(0, buffer.length - avail);
      }

      let content: string;
      let visibleWidth: number;
      if (buffer.length === 0 && question.placeholder) {
         const placeholder = ttys.stringJustify(question.placeholder, avail, {
            align: 'right',
            overflow: 'hidden',
         });
         content =
            `${INVERT_ON} ${INVERT_OFF}` +
            `${fgRgb(P.overlay0)}${SGR.italic}${placeholder}${SGR.reset}`;
         visibleWidth = 1 + ttys.stringWidth(placeholder);
      } else {
         const visibleEnd = state.viewOffset + avail;
         const pre = buffer.slice(state.viewOffset, Math.min(buffer.cursor, visibleEnd));
         const cursorChar = buffer.charAt(buffer.cursor) ?? ' ';
         const post = buffer.slice(buffer.cursor + 1, visibleEnd);
         content =
            `${fgRgb(P.text)}${pre}` + `${INVERT_ON}${cursorChar}${INVERT_OFF}` + post;
         visibleWidth = ttys.stringWidth(pre + cursorChar + post);
      }

      const border = fgRgb(this.error ? P.red : P.lavender);
      const padding = ' '.repeat(Math.max(0, inner - visibleWidth));

      return [
         padBg(`${margin}${border}╭${'─'.repeat(fieldWidth - 2)}╮`, width, P.base),
         padBg(
            `${margin}${border}│ ${content}${bgRgb(P.base)}${padding} ${border}│`,
            width,
            P.base
         ),
         padBg(`${margin}${border}╰${'─'.repeat(fieldWidth - 2)}╯`, width, P.base),
      ];
   }

   /**
    * Renders the filtered dropdown option list below the filter field.
    * @param question - Dropdown question.
    * @param state - Question state.
    * @param width - Terminal width.
    * @param budget - Maximum rows the list may occupy.
    * @param margin - Left margin that horizontally centers the block.
    * @returns Rendered list lines.
    */
   private renderDropdownList(
      question: FormQuestion,
      state: QuestionState,
      width: number,
      budget: number,
      margin: string
   ): string[] {
      const lines: string[] = [];
      const filtered = this.filterOptions(question, state);
      const fieldWidth = Math.max(16, Math.min(64, width - 8));
      const blank = (): string => padBg('', width, P.base);

      // Fixed list height based on the full option list so the block (and the
      // inline progress below it) does not move while the filter narrows it
      const listHeight = Math.max(1, Math.min(question.options?.length ?? 1, budget));

      if (filtered.length === 0) {
         lines.push(
            padBg(
               `${margin}  ${fgRgb(P.overlay0)}${SGR.italic}No matching options${SGR.reset}`,
               width,
               P.base
            )
         );
      } else {
         const selection = Math.min(state.selection, filtered.length - 1);
         const visible = Math.max(
            1,
            Math.min(filtered.length, filtered.length > listHeight ? listHeight - 2 : listHeight)
         );
         let start = Math.max(0, selection - Math.floor(visible / 2));
         start = Math.min(start, Math.max(0, filtered.length - visible));
         const end = Math.min(filtered.length, start + visible);

         if (start > 0) {
            lines.push(
               padBg(`${margin}  ${fgRgb(P.overlay0)}${SGR.dim}↑ ${start} more${SGR.normal}`, width, P.base)
            );
         }
         for (let i = start; i < end; i++) {
            if (i === selection) {
               const row = `${bgRgb(P.surface0)}${fgRgb(P.lavender)} ❯ ${SGR.bright}${filtered[i]}${SGR.normal}`;
               const padding = ' '.repeat(Math.max(0, fieldWidth - ttys.stringWidth(` ❯ ${filtered[i]}`)));
               lines.push(padBg(`${margin}${row}${padding}${SGR.reset}`, width, P.base));
            } else {
               lines.push(padBg(`${margin}   ${fgRgb(P.text)}${filtered[i]}`, width, P.base));
            }
         }
         if (end < filtered.length) {
            lines.push(
               padBg(
                  `${margin}  ${fgRgb(P.overlay0)}${SGR.dim}↓ ${filtered.length - end} more${SGR.normal}`,
                  width,
                  P.base
               )
            );
         }
      }

      while (lines.length < listHeight) lines.push(blank());
      return lines.slice(0, listHeight);
   }

   /**
    * Renders a horizontal segmented pill (choice options or confirm buttons).
    * @param labels - Segment labels.
    * @param selection - Selected segment index.
    * @param width - Terminal width.
    * @param margin - Left margin that horizontally centers the block.
    * @returns A single rendered line.
    */
   private renderSegments(labels: string[], selection: number, width: number, margin: string): string {
      const segments = labels.map((label, i) => {
         if (i === selection) {
            return `${bgRgb(P.lavender)}${fgRgb(P.crust)}${SGR.bright}  ${label}  ${SGR.normal}`;
         }
         return `${bgRgb(P.surface0)}${fgRgb(P.text)}  ${label}  `;
      });
      return padBg(`${margin}${segments.join(`${bgRgb(P.base)} `)}`, width, P.base);
   }

   /**
    * Renders the footer band with key hints and, optionally, the progress indicator.
    * @param question - Current question (affects key hints).
    * @param width - Terminal width.
    * @param includeProgress - Whether to show the progress on the right (fallback when inline progress is off).
    * @returns The rendered footer line.
    */
   private renderFooter(question: FormQuestion, width: number, includeProgress: boolean): string {
      const hints: [string, string][] = [];
      switch (question.type) {
         case 'textbox':
            hints.push(['Enter', 'continue']);
            break;
         case 'dropdown':
            hints.push(['↑ ↓', 'select'], ['type', 'to filter'], ['Enter', 'continue']);
            break;
         case 'choice':
         case 'confirm':
            hints.push(['← →', 'select'], ['Enter', 'continue']);
            break;
      }
      if (question.optional) hints.push(['Shift+→', 'skip']);
      if (this.index > 0) hints.push(['Shift+←', 'back']);
      hints.push(['Esc', 'cancel']);

      const hintText = hints
         .map(
            ([keyLabel, label]) =>
               `${SGR.bright}${fgRgb(P.cyan)}${keyLabel}${fgRgb(P.overlay0)}${SGR.normal} ${label}`
         )
         .join(`${fgRgb(P.surface1)} · ${fgRgb(P.overlay0)}`);

      if (!includeProgress) {
         return padBg('  ' + fgRgb(P.overlay0) + hintText, width, P.mantle);
      }

      const footer =
         '  ' +
         ttys.stringJustify([fgRgb(P.overlay0) + hintText, this.renderProgress()], width - 4, {
            align: 'spacebetween',
            filler: ' ',
            overflow: 'collapse',
            collapseLocation: 'mid',
         }) +
         '  ';
      return padBg(footer, width, P.mantle);
   }

   /**
    * Renders the progress indicator: colored dots when there are fewer than 3
    * questions (filled/current/pending), a progress bar otherwise.
    * @returns The rendered progress fragment.
    */
   private renderProgress(): string {
      const total = this.questions.length;
      const answered = this.questions.filter((q) => q.key in this.answers).length;

      if (total < 3) {
         return this.questions
            .map((q, i) => {
               if (q.key in this.answers) return `${fgRgb(P.green)}●`;
               if (i === this.index) return `${fgRgb(P.lavender)}●`;
               return `${fgRgb(P.surface1)}●`;
            })
            .join(' ');
      }

      const barWidth = 16;
      const filled = Math.round((barWidth * answered) / total);
      return (
         `${fgRgb(P.green)}${'━'.repeat(filled)}` +
         `${fgRgb(P.surface1)}${'━'.repeat(barWidth - filled)}`
      );
   }
}
