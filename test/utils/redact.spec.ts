import { describe, expect, it } from 'bun:test';

import { redactSensitiveContent } from '@/utils/redact';

describe('redactSensitiveContent', () => {
   it('should redact sensitive-looking values and preserve surrounding text', () => {
      const input = [
         'before',
         'api_key="first-secret"',
         'middle',
         'access_token="second-secret"',
         'after',
      ].join('\n');

      const result = redactSensitiveContent(input);

      expect(result.redactionCount).toBe(2);
      expect(result.text).toContain('before');
      expect(result.text).toContain('middle');
      expect(result.text).toContain('after');
      expect(result.text).not.toContain('first-secret');
      expect(result.text).not.toContain('second-secret');
   });

   it('should redact repeated matches from the same pattern', () => {
      const result = redactSensitiveContent(
         'sk-12345678901234567890123456789012 sk-abcdefghijklmnopqrstuvwxzy123456'
      );

      expect(result.redactionCount).toBe(2);
      expect(result.text).toBe('[REDACTED_SENSITIVE_CONTENT] [REDACTED_SENSITIVE_CONTENT]');
   });

   it('should redact logger-style sensitive values', () => {
      const result = redactSensitiveContent(
         'fetch https://user:pass@example.com with authorization=BearerToken and http.extraHeader=secret'
      );

      expect(result.redactionCount).toBe(3);
      expect(result.text).toContain('https://[REDACTED]@example.com');
      expect(result.text).toContain('authorization=[REDACTED]');
      expect(result.text).toContain('http.extraHeader=[REDACTED]');
      expect(result.text).not.toContain('user:pass');
      expect(result.text).not.toContain('BearerToken');
   });
});
