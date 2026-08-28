import { describe, expect, it } from 'bun:test';
import litedent from 'litedent';

import { redactSensitiveContent } from '@/utils/redact';

describe('redactSensitiveContent', () => {
   it('should redact sensitive-looking values and preserve surrounding text', () => {
      const input = litedent`
         before
         api_key="first-secret"
         middle
         access_token="second-secret"
         after
      `;

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

   it('should redact complete scalar values after named sensitive keys', () => {
      const result = redactSensitiveContent(
         `apiKey: 'quoted-"secret'\naccess_token=unquoted-secret\nauthorization: BearerToken`
      );

      expect(result.redactionCount).toBe(3);
      expect(result.text).toBe(
         `apiKey: '[REDACTED]'\naccess_token=[REDACTED]\nauthorization: [REDACTED]`
      );
   });

   it('should count overlapping secret shapes only once', () => {
      const result = redactSensitiveContent('apiKey="sk-12345678901234567890123456789012"');

      expect(result.redactionCount).toBe(1);
      expect(result.text).toBe('apiKey="[REDACTED]"');
   });

   it('should ignore object and expression values after sensitive-looking keys', () => {
      const input = litedent`
         apiKey: envRefSchema.default({ env: 'LLM_API_KEY' }),
         model: { apiKey: { env: 'LLM_API_KEY' }, model: { env: 'LLM_MODEL' } },
      `;

      const result = redactSensitiveContent(input);

      expect(result.redactionCount).toBe(0);
      expect(result.text).toBe(input);
   });
});
