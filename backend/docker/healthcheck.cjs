const { checkMongo } = require('./runtime.cjs');

async function main() {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT || 3000}/health`,
    {
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!response.ok || (await response.json()).status !== 'ok')
    throw new Error('HTTP not ready');
  await checkMongo();
}

main().catch(() => {
  process.exitCode = 1;
});
