
await (async (milliseconds) => {
   const MIN_SLEEP_MS = 4;
   return new Promise(resolve => {
      if (!milliseconds || milliseconds < MIN_SLEEP_MS || typeof milliseconds != 'number')
         resolve();

      // eslint-disable-next-line no-undef
      setTimeout(resolve, milliseconds);
   });
})(1000);

// eslint-disable-next-line no-undef
process.exit(0);
