import { describe, expect, it } from 'bun:test';

import { Form } from '@/modules/form';

describe('Form', () => {
   it('supports builder chaining', () => {
      const form = new Form({ title: 'Test form' });
      const chained = form
         .textbox('name', 'Name')
         .dropdown('license', 'License', ['mit', 'apache-2.0'], { optional: true })
         .choice('visibility', 'Visibility', ['private', 'public'], { initial: 'private' })
         .confirm('proceed', 'Proceed?');
      expect(chained).toBe(form);
   });

   it('rejects when run without questions', async () => {
      const form = new Form();
      expect(form.run()).rejects.toThrow('no questions');
   });

   it('rejects when run outside an interactive terminal', async () => {
      const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
      try {
         const form = new Form().textbox('name', 'Name');
         expect(form.run()).rejects.toThrow('interactive terminal');
      } finally {
         if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
         if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      }
   });
});
