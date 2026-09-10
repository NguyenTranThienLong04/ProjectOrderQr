import 'dotenv/config';
import { setServers } from 'node:dns';
import {
  buildDataset,
  COLLECTIONS,
  fingerprint,
  validateDataset,
} from './ai-demo/dataset';
import { DATASET_ID, DEMO_LABEL } from './ai-demo/catalog';
import { requireDemoConfig, runDemo } from './ai-demo/store';

async function main(): Promise<void> {
  const action = process.argv[2];
  if (
    !['seed', 'reset', 'validate'].includes(action) ||
    process.argv.length !== 3
  )
    throw new Error(
      'Usage: npm run seed:ai-demo | reset:ai-demo | validate:ai-demo (no extra arguments).',
    );
  if (action === 'validate') {
    const dataset = buildDataset();
    await validateDataset(dataset);
    console.log(
      JSON.stringify(
        {
          dataset: DATASET_ID,
          label: DEMO_LABEL,
          sha256: fingerprint(dataset),
          counts: Object.fromEntries(
            COLLECTIONS.map((name) => [name, dataset[name].length]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  requireDemoConfig(process.env); // Reject before DNS or DB access.
  if (process.env.CUSTOM_DNS_SERVERS)
    setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
  const counts = await runDemo(action as 'seed' | 'reset', process.env);
  console.log(
    JSON.stringify(
      {
        dataset: DATASET_ID,
        label: DEMO_LABEL,
        action,
        database: process.env.AI_DEMO_DB_NAME,
        changed: counts,
      },
      null,
      2,
    ),
  );
}

void main().catch((error: unknown) => {
  // Driver errors can contain hosts/credentials. Only local validation/refusal
  // messages are displayed; network failures are summarized without the URI.
  const message = error instanceof Error ? error.message : '';
  console.error(
    /^(AI demo|AI_DEMO_|Demo |Reset refused|Invalid demo dataset|Usage:)/.test(
      message,
    )
      ? message
      : 'AI demo failed; no partial fixture transaction committed. Check dedicated DB access and replica-set support.',
  );
  process.exitCode = 1;
});
