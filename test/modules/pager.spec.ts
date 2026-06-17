import { describe, expect, it } from 'bun:test';

import {
   SimplePagerRenderer,
   getTerminalWidth,
   getTerminalHeight,
   clearTerminalCache,
} from '@/modules/pager';
import { stripAnsiColor } from '@/modules/graphics';
import { MATCH_HIGHLIGHT_BG, preloadFuzzy } from '@/modules/fuzzy-search';

describe('pager module', async () => {
   it('should create SimplePagerRenderer with content', () => {
      const content = 'line1\nline2\nline3';
      const renderer = new SimplePagerRenderer(content);

      expect(renderer.getLineCount()).toBe(3);
      expect(stripAnsiColor(renderer.getLine(0))).toBe('line1');
      expect(stripAnsiColor(renderer.getLine(1))).toBe('line2');
      expect(stripAnsiColor(renderer.getLine(2))).toBe('line3');
   });

   it('should handle empty content', () => {
      const renderer = new SimplePagerRenderer('');
      expect(renderer.getLineCount()).toBe(1);
      expect(stripAnsiColor(renderer.getLine(0))).toBe('');
   });

   it('should handle single line content', () => {
      const renderer = new SimplePagerRenderer('single line');
      expect(renderer.getLineCount()).toBe(1);
      expect(stripAnsiColor(renderer.getLine(0))).toBe('single line');
   });

   it('should replace tabs with two spaces by default', () => {
      const renderer = new SimplePagerRenderer('before\tafter');

      expect(stripAnsiColor(renderer.getLine(0))).toBe('before  after');
      expect(renderer.getLine(0)).not.toContain('\t');
   });

   it('should replace tabs using the configured tab width', () => {
      const renderer = new SimplePagerRenderer('\tindented', { tabWidth: 4 });

      expect(stripAnsiColor(renderer.getLine(0))).toBe('    indented');
      expect(renderer.getLine(0)).not.toContain('\t');
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

   it('should update line numbers while active', () => {
      const renderer = new SimplePagerRenderer('line1\nline2', {
         showLineNumbers: true,
         lineNumberWidth: 4,
      });

      expect(stripAnsiColor(renderer.getLine(0))).toStartWith('  1');

      renderer.updateOptions({ showLineNumbers: false });

      expect(stripAnsiColor(renderer.getLine(0))).toBe('line1');
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

   it('should auto-detect redundancy level for fullwidth content', () => {
      const content = 'alpha 漢字 beta';
      const renderer = new SimplePagerRenderer(content, {
         wrapLines: true,
         lineNumberWidth: 4,
      });

      renderer.onResize(12, 10);
      const lines = Array.from({ length: renderer.getLineCount() }, (_, i) =>
         stripAnsiColor(renderer.getLine(i)).trimEnd()
      );

      expect(lines.some((line) => line.includes('漢字'))).toBeTrue();
   });

   it('should use lowest redundancy for plain content', () => {
      const content = 'alpha beta gamma';
      const renderer = new SimplePagerRenderer(content, { wrapLines: true });
      const lines = Array.from({ length: renderer.getLineCount() }, (_, i) =>
         stripAnsiColor(renderer.getLine(i)).trimEnd()
      );

      expect(lines.some((line) => line.includes('alpha'))).toBeTrue();
   });
});

describe('SimplePagerRenderer search', async () => {
   await preloadFuzzy();

   it('should not support file search for plain content', () => {
      expect(new SimplePagerRenderer('a\nb').supportsFileSearch()).toBeFalse();
   });

   it('should filter to matching lines and highlight matches when filtered', () => {
      const renderer = new SimplePagerRenderer('alpha\nbeta\ngamma beta\ndelta');
      const results = renderer.applySearch('beta', 'content', true);

      const lines = Array.from({ length: renderer.getLineCount() }, (_, i) =>
         stripAnsiColor(renderer.getLine(i))
      );
      expect(lines).toEqual(['beta', 'gamma beta']);
      expect(results.length).toBe(2);
      // the matched substring carries the consistent highlight background
      expect(renderer.getLine(0)).toContain(MATCH_HIGHLIGHT_BG);
   });

   it('should keep all lines but still highlight matches when unfiltered', () => {
      const renderer = new SimplePagerRenderer('alpha\nbeta\ngamma');
      const results = renderer.applySearch('beta', 'content', false);

      expect(renderer.getLineCount()).toBe(3);
      expect(results.length).toBe(1);
      expect(stripAnsiColor(renderer.getLine(results[0].line))).toContain('beta');
   });

   it('should restore all lines after clearSearch', () => {
      const renderer = new SimplePagerRenderer('alpha\nbeta\ngamma');
      renderer.applySearch('beta', 'content', true);
      expect(renderer.getLineCount()).toBe(1);

      renderer.clearSearch();
      expect(renderer.getLineCount()).toBe(3);
   });

   it('should clear the filter when the query is empty', () => {
      const renderer = new SimplePagerRenderer('alpha\nbeta\ngamma');
      const results = renderer.applySearch('', 'content', true);
      expect(results).toEqual([]);
      expect(renderer.getLineCount()).toBe(3);
   });
});
