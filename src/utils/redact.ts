import { SENSITIVE_CONTENTS_REGEXES } from '@/consts';

const REDACTION_TOKEN = '[REDACTED_SENSITIVE_CONTENT]';

type RedactionReplacement = string | ((...args: string[]) => string);

interface RedactionPattern {
   regex: RegExp;
   replacement: RedactionReplacement;
}

const ADDITIONAL_SENSITIVE_PATTERNS: RedactionPattern[] = [
   {
      regex: /(https?:\/\/)([^:\s/@]+):([^@\s]+)@/gi,
      replacement: '$1[REDACTED]@',
   },
   {
      regex: /\b(sk-(?:ant-|or-)?[A-Za-z0-9_-]{24,})\b/g,
      replacement: REDACTION_TOKEN,
   },
   {
      regex: /\b((?:api[_-]?key|access[_-]?token|private[_-]?key|authorization|http\.extraheader)\s*[=:]\s*)(["']?)[^\s"']+/gi,
      replacement: '$1$2[REDACTED]',
   },
];

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

   for (const regex of SENSITIVE_CONTENTS_REGEXES) {
      const globalRegex = toGlobalRegex(regex);
      redactedText = redactedText.replace(globalRegex, () => {
         redactionCount++;
         return REDACTION_TOKEN;
      });
   }

   for (const pattern of ADDITIONAL_SENSITIVE_PATTERNS) {
      const globalRegex = toGlobalRegex(pattern.regex);
      redactedText = redactedText.replace(globalRegex, (...args: string[]) => {
         redactionCount++;
         if (typeof pattern.replacement === 'function') {
            return pattern.replacement(...args);
         }
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
