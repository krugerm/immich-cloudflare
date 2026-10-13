import { app } from './app';
import { handleBackupBatch, type BackupMessage } from './backup/consumer';
import { runScheduled } from './cron';
import { handleMlBatch, type MlQueueMessage } from './ml/job';
import { handleProcessBatch, handleProcessDeadLetters } from './process/consumer';
import type { ProcessMessage } from './upload/routes';

export { RealtimeHub } from './realtime/hub'; // stream H
export { MediaContainer } from './container/hub';
export { ContainerProxy } from '@cloudflare/containers'; // required for MediaContainer outbound handlers
export { MlContainer, MlSearchContainer } from './ml/hub'; // phase 4
export { ClusterHub } from './faces/hub'; // phase 4

type QueueMessage = ProcessMessage | BackupMessage | MlQueueMessage;

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    if (env.DISABLE_QUEUE_CONSUMERS === 'true') return batch.ackAll(); // set only in tests
    if (batch.queue === 'asset-process') return handleProcessBatch(batch as MessageBatch<ProcessMessage>, env);
    if (batch.queue === 'asset-process-dlq') return handleProcessDeadLetters(batch as MessageBatch<ProcessMessage>, env);
    if (batch.queue === 'asset-backup') return handleBackupBatch(batch as MessageBatch<BackupMessage>, env);
    if (batch.queue === 'asset-ml') return handleMlBatch(batch as MessageBatch<MlQueueMessage>, env); // phase 4
    batch.retryAll(); // unknown queue: keep the messages
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
