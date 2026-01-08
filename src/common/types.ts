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

export interface CommandStructure {
   /**
    * The root node of the command's argument structure tree.
    * `$root` itself represents the first level of arguments/commands.
    */
   $root: CommandArgNode | string[];
}

export type CommandArgNode = {
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
   $allOf?: string[];
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
   $anyOf?: string[];
} & {
   /**
    * Sub-commands or flags that can be present after this node.
    *
    * if the type is string[], its the same as $anyOf
    */
   [key: string]: CommandArgNode | string[];
}
