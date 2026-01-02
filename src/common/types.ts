import { ArgsSet } from '@/utils/arguments';
import { RgbVec } from '@/utils/graphics';

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
