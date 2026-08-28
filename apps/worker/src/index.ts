import pino from 'pino';
import { JOB_QUEUES } from '@varuna/shared';

/**
 * BullMQ job consumers. Shares code with apps/api (same image, different entrypoint —
 * 03_ARCHITECTURE §3.3). Queue processors land in the phases that own their jobs:
 *   ingest    → Phase 4    inference → Phase 5/6
 *   drift     → Phase 7    ais-import → Phase 8
 *   scoring   → Phase 9    report    → Phase 12
 */
const logger = pino({ name: 'varuna-worker' });

async function main() {
  logger.info(
    { queues: Object.keys(JOB_QUEUES) },
    'varuna-worker starting (no processors registered yet)',
  );
  // TODO(phase-4+): new Worker(name, processor, { connection, concurrency }) per queue.
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});
