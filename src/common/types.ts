import { ArgsSet } from '@/modules/arguments';
import { RgbVec } from '@/modules/graphics';

export interface GdxContext {
   args: ArgsSet;
   git$: string | string[];
}

export interface SpinnerOptions {
   /** Message to display next to the spinner */
   message?: string;
   /** Interval between spinner frames in milliseconds (default: 80) */
   interval?: number;
   /** Spinner characters to cycle through */
   frames?: string[];
   /** Enable animated gradient for the message */
   animateGradient?: boolean;
   /** Starting color for gradient animation */
   gradientColor?: RgbVec;
   /** Ending color for gradient animation */
   gradientColorBg?: RgbVec;
   /** Speed of gradient animation (0-1, default: 0.02) */
   gradientSpeed?: number;
}

export interface CommandHelpObj {
   long: () => string;
   short: string;
   usage: () => string;
}

/**
 * Context passed to completion thunks during resolution.
 * @property git$ - The git executable path/command array.
 * @property args - Full argument list relative to the command root.
 * @property index - The index of the token currently being processed.
 * @property cursorIndex - The target index where completion is requested.
 * @property mode - 'history' when verifying past tokens, 'suggest' when resolving the active token.
 */
export interface CompletionThunkContext {
   git$: string | string[];
   args: string[];
   index: number;
   cursorIndex: number;
   mode: 'history' | 'suggest';
}

/**
 * A function that returns a structure node or list of strings dynamically.
 * Can be async. Used for lazy loading suggestions (e.g. from git forks or branches).
 *
 * @returns A CommandArgNode (structure), string[] (aliases), or another thunk.
 */
export type CommandArgThunk = (
   ctx: CompletionThunkContext
) =>
   | CommandArgNode
   | string[]
   | CommandArgThunk
   | Promise<CommandArgNode | string[] | CommandArgThunk>;

/**
 * A function that returns a list of string suggestions dynamically.
 * Can be async. Used for dynamic lists in $anyOf or $allOf.
 *
 * @returns string[] or another list thunk.
 */
export type CommandArgListThunk = (
   ctx: CompletionThunkContext
) => string[] | CommandArgListThunk | Promise<string[] | CommandArgListThunk>;

export interface CommandStructure {
   /**
    * The root node of the command's argument structure tree.
    * `$root` itself represents the first level of arguments/commands.
    */
   $root: CommandArgNode | string[];
}

export interface CommandArgNode {
   /**
    * All of the sub-commands listed here can be present anywhere starting from this node
    * to all of its children, where order does not matter.
    *
    * @example
    * {
    *  foo: {
    *    $allOf: ['--foo', '--bar'],
    *    baz: {}
    *  }
    * }
    *
    * // will match:
    * // foo --bar --foo baz
    * // foo --foo baz --bar
    * // foo --foo baz
    *
    * // but not:
    * // baz --foo # missing `foo` before `baz`
    * // --bar foo --foo baz # `--bar` cannot appear before `foo`
    */
   $allOf?: string[] | CommandArgListThunk;
   /**
    * A choice of sub-commands listed, where either one can present
    * after this node (only this node).
    *
    * @example
    * {
    *  foo: {
    *    $anyOf: ['--foo', '--bar'],
    *    baz: {}
    *  }
    * }
    *
    * // will match:
    * // foo --bar baz
    * // foo --foo baz
    *
    * // but not:
    * // foo --foo --bar baz # both `--foo` and `--bar` present
    * // baz --foo # missing `foo` before `baz`
    *
    * // $anyOf can be simplified from:
    * {
    *  foo: {
    *    $anyOf: ['a', 'b', 'c']
    *  }
    * }
    *
    * // to:
    * {
    *  foo: ['a', 'b', 'c']
    * }
    *
    * // or
    * {
    *  foo: {
    *    a: {},
    *    b: {},
    *    c: {}
    *  }
    * }
    */
   $anyOf?: string[] | CommandArgListThunk;
   /**
    * Sub-commands or flags that can be present after this node.
    *
    * if the type is string[], its the same as $anyOf
    */
   [key: string]: CommandArgNode | string[] | CommandArgThunk | CommandArgListThunk | undefined;
}
