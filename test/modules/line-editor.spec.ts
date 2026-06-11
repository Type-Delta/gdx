import { describe, expect, it } from 'bun:test';

import { LineBuffer, parseInput } from '@/modules/line-editor';

describe('parseInput', () => {
   it('parses plain printable characters', () => {
      const keys = parseInput('abc');
      expect(keys).toHaveLength(3);
      expect(keys.map((k) => k.char)).toEqual(['a', 'b', 'c']);
      expect(keys.every((k) => k.name === 'char' && !k.ctrl && !k.alt)).toBe(true);
   });

   it('parses arrow keys with modifiers', () => {
      expect(parseInput('\x1b[D')[0]).toMatchObject({ name: 'left', ctrl: false });
      expect(parseInput('\x1b[1;5D')[0]).toMatchObject({ name: 'left', ctrl: true });
      expect(parseInput('\x1b[1;5C')[0]).toMatchObject({ name: 'right', ctrl: true });
      expect(parseInput('\x1b[1;3D')[0]).toMatchObject({ name: 'left', alt: true });
      expect(parseInput('\x1b[1;2C')[0]).toMatchObject({ name: 'right', shift: true });
   });

   it('parses home, end, and delete sequences', () => {
      expect(parseInput('\x1b[H')[0].name).toBe('home');
      expect(parseInput('\x1b[F')[0].name).toBe('end');
      expect(parseInput('\x1b[1~')[0].name).toBe('home');
      expect(parseInput('\x1b[4~')[0].name).toBe('end');
      expect(parseInput('\x1b[3~')[0]).toMatchObject({ name: 'delete', ctrl: false });
      expect(parseInput('\x1b[3;5~')[0]).toMatchObject({ name: 'delete', ctrl: true });
   });

   it('parses backspace variants', () => {
      expect(parseInput('\x7f')[0]).toMatchObject({ name: 'backspace', ctrl: false, alt: false });
      expect(parseInput('\x08')[0]).toMatchObject({ name: 'backspace', ctrl: true });
      expect(parseInput('\x1b\x7f')[0]).toMatchObject({ name: 'backspace', alt: true });
   });

   it('parses control characters and special keys', () => {
      expect(parseInput('\x03')[0]).toMatchObject({ name: 'c', ctrl: true });
      expect(parseInput('\x01')[0]).toMatchObject({ name: 'a', ctrl: true });
      expect(parseInput('\r')[0].name).toBe('enter');
      expect(parseInput('\r\n')).toHaveLength(1);
      expect(parseInput('\t')[0]).toMatchObject({ name: 'tab', shift: false });
      expect(parseInput('\x1b[Z')[0]).toMatchObject({ name: 'tab', shift: true });
      expect(parseInput('\x1b')[0].name).toBe('escape');
   });

   it('parses alt-prefixed characters', () => {
      expect(parseInput('\x1bb')[0]).toMatchObject({ name: 'b', alt: true });
      expect(parseInput('\x1bf')[0]).toMatchObject({ name: 'f', alt: true });
   });

   it('extracts printable characters from bracketed paste', () => {
      const keys = parseInput('\x1b[200~hi\x1b[201~');
      expect(keys.map((k) => k.char)).toEqual(['h', 'i']);
   });

   it('parses non-BMP characters as single events', () => {
      const keys = parseInput('a😀b');
      expect(keys).toHaveLength(3);
      expect(keys[1].char).toBe('😀');
   });
});

describe('LineBuffer', () => {
   it('inserts text at the cursor', () => {
      const buffer = new LineBuffer('helloworld');
      buffer.cursor = 5;
      buffer.insert(', ');
      expect(buffer.text).toBe('hello, world');
      expect(buffer.cursor).toBe(7);
   });

   it('moves by word with ctrl+left/right', () => {
      const buffer = new LineBuffer('hello brave world');
      buffer.handleKey({ name: 'left', ctrl: true, alt: false, shift: false });
      expect(buffer.cursor).toBe(12); // start of "world"
      buffer.handleKey({ name: 'left', ctrl: true, alt: false, shift: false });
      expect(buffer.cursor).toBe(6); // start of "brave"
      buffer.handleKey({ name: 'right', ctrl: true, alt: false, shift: false });
      expect(buffer.cursor).toBe(11); // end of "brave"
   });

   it('deletes the previous word with ctrl+backspace', () => {
      const buffer = new LineBuffer('hello world');
      buffer.handleKey({ name: 'backspace', ctrl: true, alt: false, shift: false });
      expect(buffer.text).toBe('hello ');
      expect(buffer.cursor).toBe(6);
   });

   it('deletes the next word with ctrl+delete', () => {
      const buffer = new LineBuffer('hello world');
      buffer.cursor = 0;
      buffer.handleKey({ name: 'delete', ctrl: true, alt: false, shift: false });
      expect(buffer.text).toBe(' world');
   });

   it('supports home/end and kill shortcuts', () => {
      const buffer = new LineBuffer('hello world');
      buffer.handleKey({ name: 'home', ctrl: false, alt: false, shift: false });
      expect(buffer.cursor).toBe(0);
      buffer.handleKey({ name: 'end', ctrl: false, alt: false, shift: false });
      expect(buffer.cursor).toBe(11);

      buffer.cursor = 5;
      buffer.handleKey({ name: 'k', ctrl: true, alt: false, shift: false });
      expect(buffer.text).toBe('hello');
      buffer.handleKey({ name: 'u', ctrl: true, alt: false, shift: false });
      expect(buffer.text).toBe('');
   });

   it('handles word operations across punctuation', () => {
      const buffer = new LineBuffer('foo --bar-baz');
      buffer.handleKey({ name: 'backspace', ctrl: true, alt: false, shift: false });
      expect(buffer.text).toBe('foo --bar-');
      buffer.handleKey({ name: 'backspace', ctrl: true, alt: false, shift: false });
      expect(buffer.text).toBe('foo --');
   });

   it('ignores unhandled keys', () => {
      const buffer = new LineBuffer('abc');
      const consumed = buffer.handleKey({ name: 'pageup', ctrl: false, alt: false, shift: false });
      expect(consumed).toBe(false);
      expect(buffer.text).toBe('abc');
   });
});
