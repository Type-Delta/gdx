import { SENSITIVE_CONTENT_PATTERNS } from '@/consts';

const REDACTION_TOKEN = '[REDACTED_SENSITIVE_CONTENT]';

/**
 * Creates a global copy of a regular expression while preserving its other flags.
 */
function toGlobalRegex(regex: RegExp): RegExp {
   const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
   return new RegExp(regex.source, flags);
}

/**
 * Redacts text that matches the project's sensitive-content patterns.
 */
export function redactSensitiveContent(text: string): { text: string; redactionCount: number } {
   let redactedText = text;
   let redactionCount = 0;

   for (const pattern of SENSITIVE_CONTENT_PATTERNS) {
      const globalRegex = toGlobalRegex(pattern.regex);
      redactedText = redactedText.replace(globalRegex, (...args: string[]) => {
         redactionCount++;
         if (!pattern.replacement) return REDACTION_TOKEN;

         return pattern.replacement.replace(/\$(\d+)/g, (_, groupIndex: string) => {
            return args[Number(groupIndex)] || '';
         });
      });
   }

   return { text: redactedText, redactionCount };
}

/**
 * Redacts sensitive text and returns only the sanitized string.
 */
export function redactSensitiveText(text: string): string {
   return redactSensitiveContent(text).text;
}
