import { afterAll, describe, expect } from 'bun:test';
import Logger from '@/utils/logger';
import { createGdxContext, createTestEnv } from '@/utils/testHelper';
import global from '@/global';

describe('Logger buffer capture', async () => {
   const { tmpDir, buffer, cleanup, it } = await createTestEnv();
   afterAll(cleanup);

   it('should respect log level for stdout/stderr but capture all logs in buffer.logs', async () => {
      // Set log level to 'warn' (so debug and info are hidden from stdout)
      const previousLogLevel = global.logLevel;
      global.logLevel = 'warn';

      Logger.debug('debug message', 'test-module');
      Logger.info('info message', 'test-module');
      Logger.warn('warn message', 'test-module');
      Logger.error('error message', 'test-module');
      Logger.fatal('fatal message', 'test-module');

      // stdout should only contain warn (not debug or info)
      expect(buffer.stdout).not.toContain('debug message');
      expect(buffer.stdout).not.toContain('info message');
      expect(buffer.stdout).toContain('warn message');

      // stderr should contain error and fatal
      expect(buffer.stderr).toContain('error message');
      expect(buffer.stderr).toContain('fatal message');

      // buffer.logs should contain ALL log levels (independent of global.logLevel)
      expect(buffer.logs).toContain('[DEBUG] test-module: debug message');
      expect(buffer.logs).toContain('[INFO ] test-module: info message');
      expect(buffer.logs).toContain('[WARN ] test-module: warn message');
      expect(buffer.logs).toContain('[ERROR] test-module: error message');
      expect(buffer.logs).toContain('[FATAL] test-module: fatal message');

      // Restore log level
      global.logLevel = previousLogLevel;
   });

   it('should not mix logs between tests', async () => {
      // This test should start with empty buffer.logs (auto-reset)
      expect(buffer.logs).toBe('');

      Logger.info('isolated log', 'test-module');

      // Should only contain this test's log
      expect(buffer.logs).toContain('[INFO ] test-module: isolated log');
      expect(buffer.logs).not.toContain('debug message');
      expect(buffer.logs).not.toContain('warn message');
   });

   it('should capture logs even when SHOULD_WRITE_LOGS is false', async () => {
      // Tests have SHOULD_WRITE_LOGS=false by default (mocked in testHelper)
      // but buffer.logs should still capture everything

      Logger.warn('test warning', 'test-module');

      expect(buffer.logs).toContain('[WARN ] test-module: test warning');
   });

   it('should show debug and info in stdout when log level is debug', async () => {
      const previousLogLevel = global.logLevel;
      global.logLevel = 'debug';

      Logger.debug('debug message', 'test-module');
      Logger.info('info message', 'test-module');

      // Both should appear in stdout when log level is debug
      expect(buffer.stdout).toContain('debug message');
      expect(buffer.stdout).toContain('info message');

      // And both should be in logs
      expect(buffer.logs).toContain('[DEBUG] test-module: debug message');
      expect(buffer.logs).toContain('[INFO ] test-module: info message');

      global.logLevel = previousLogLevel;
   });

   it('should format log timestamps correctly', async () => {
      Logger.info('timestamped log', 'test-module');

      // Should contain ISO timestamp format (YYYY-MM-DDTHH:MM:SS)
      expect(buffer.logs).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(buffer.logs).toContain('[INFO ] test-module: timestamped log');
   });
});
