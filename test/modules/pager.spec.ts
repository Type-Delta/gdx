import { describe, expect, afterAll } from 'bun:test';

import {
   SimplePagerRenderer,
   getTerminalWidth,
   getTerminalHeight,
   clearTerminalCache,
} from '@/modules/pager';
import { createTestEnv } from '@/utils/testHelper';
import { stripAnsiColor } from '@/modules/graphics';

describe('pager module', async () => {
   const { cleanup, it } = await createTestEnv();
   afterAll(cleanup);

   it('should create SimplePagerRenderer with content', () => {
      const content = 'line1\nline2\nline3';
      const renderer = new SimplePagerRenderer(content);

      expect(renderer.getLineCount()).toBe(3);
      expect(renderer.getLine(0)).toBe('line1');
      expect(renderer.getLine(1)).toBe('line2');
      expect(renderer.getLine(2)).toBe('line3');
   });

   it('should handle empty content', () => {
      const renderer = new SimplePagerRenderer('');
      expect(renderer.getLineCount()).toBe(1);
      expect(renderer.getLine(0)).toBe('');
   });

   it('should handle single line content', () => {
      const renderer = new SimplePagerRenderer('single line');
      expect(renderer.getLineCount()).toBe(1);
      expect(renderer.getLine(0)).toBe('single line');
   });

   it('should show line numbers when enabled', () => {
      const content = 'line1\nline2\nline3';
      const renderer = new SimplePagerRenderer(content, {
         showLineNumbers: true,
         lineNumberWidth: 4,
      });

      expect(renderer.getLine(0)).toContain('1');
      expect(renderer.getLine(1)).toContain('2');
      expect(renderer.getLine(2)).toContain('3');
   });

   it('should render correct number of lines', () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      const renderer = new SimplePagerRenderer(content);

      const rendered = renderer.render(0, 4, 80);
      expect(rendered.length).toBe(3);
      // Check content after stripping ANSI codes
      expect(stripAnsiColor(rendered[0]).trim()).toBe('line1');
      expect(stripAnsiColor(rendered[1]).trim()).toBe('line2');
      expect(stripAnsiColor(rendered[2]).trim()).toBe('line3');
   });

   it('should handle render with offset', () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      const renderer = new SimplePagerRenderer(content);

      const rendered = renderer.render(2, 3, 80);
      expect(rendered.length).toBe(2);
      expect(stripAnsiColor(rendered[0]).trim()).toBe('line3');
      expect(stripAnsiColor(rendered[1]).trim()).toBe('line4');
   });

   it('should handle render beyond content length', () => {
      const content = 'line1\nline2';
      const renderer = new SimplePagerRenderer(content);

      const rendered = renderer.render(0, 6, 80);
      expect(rendered.length).toBe(5);
      expect(stripAnsiColor(rendered[0]).trim()).toBe('line1');
      expect(stripAnsiColor(rendered[1]).trim()).toBe('line2');
      expect(stripAnsiColor(rendered[2]).trim()).toBe('');
      expect(stripAnsiColor(rendered[3]).trim()).toBe('');
      expect(stripAnsiColor(rendered[4]).trim()).toBe('');
   });

   it('should handle onResize', () => {
      const content = 'line1\nline2\nline3';
      const renderer = new SimplePagerRenderer(content);

      const initialLineCount = renderer.getLineCount();
      renderer.onResize(100, 30);

      expect(renderer.getLineCount()).toBe(initialLineCount);
   });

   it('should get terminal dimensions', () => {
      clearTerminalCache();
      const width = getTerminalWidth();
      const height = getTerminalHeight();

      expect(typeof width).toBe('number');
      expect(typeof height).toBe('number');
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
   });

   it('should cache terminal dimensions', () => {
      clearTerminalCache();
      const width1 = getTerminalWidth();
      const width2 = getTerminalWidth();

      expect(width1).toBe(width2);
   });

   it('should wrap long lines when wrapLines is enabled', () => {
      const longLine = 'a'.repeat(100);
      const renderer = new SimplePagerRenderer(longLine, { wrapLines: true });

      expect(renderer.getLineCount()).toBeGreaterThanOrEqual(1);
   });
});
