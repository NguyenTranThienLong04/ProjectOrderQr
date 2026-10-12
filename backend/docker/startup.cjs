const { setTimeout: delay } = require('node:timers/promises');
const { validateEnvironment, checkMongo } = require('./runtime.cjs');

async function main() {
  validateEnvironment();
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await checkMongo(true);
      console.log('MongoDB rs0 transaction readiness confirmed');
      return;
    } catch {
      if (Date.now() >= deadline)
        throw new Error('MongoDB replica set not ready within 60 seconds');
      await delay(1000);
    }
  }
}

main().catch((error) => {
  console.error(error.message); // Configuration names only; never print connection strings/secrets.
  process.exitCode = 1;
});
