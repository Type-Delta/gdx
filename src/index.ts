
import cmd from './commands'
import { $inherit, whichExec } from './utils/shell';

const args = process.argv.slice(2);


async function main() {
   if (args.includes('--help') || args.includes('-h')) {
      return cmd.help();
   }

   const git$ = await whichExec('git');
   if (!git$) {
      throw new Error('Git is not installed or not found in PATH.');
   }

   try {
      await $inherit`${git$} ${args}`;
   }
   catch { };
}

(async () => {
   try {
      await main();
   }
   catch (error) {
      console.error('Error:', error);
      process.exit(1);
   }
})();
