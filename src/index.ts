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

/**
 * Which consumer a queue belongs to, by its name: the defaults are asset-process, asset-process-dlq, asset-backup and
 * asset-ml, and a deployment may rename them (the Deploy to Cloudflare form, a suffix per environment) as long as the
 * name keeps its role word.
 */
export function queueKind(name: string): 'process' | 'process-dlq' | 'backup' | 'ml' | undefined {
  if (/(^|[-_])process([-_]|$)/.test(name)) return /(^|[-_])dlq([-_]|$)/.test(name) ? 'process-dlq' : 'process';
  if (/(^|[-_])backup([-_]|$)/.test(name) && !/(^|[-_])dlq([-_]|$)/.test(name)) return 'backup';
  if (/(^|[-_])ml([-_]|$)/.test(name)) return 'ml';
  return undefined;
}

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    if (env.DISABLE_QUEUE_CONSUMERS === 'true') return batch.ackAll(); // set only in tests
    switch (queueKind(batch.queue)) {
      case 'process':
        return handleProcessBatch(batch as MessageBatch<ProcessMessage>, env);
      case 'process-dlq':
        return handleProcessDeadLetters(batch as MessageBatch<ProcessMessage>, env);
      case 'backup':
        return handleBackupBatch(batch as MessageBatch<BackupMessage>, env);
      case 'ml':
        return handleMlBatch(batch as MessageBatch<MlQueueMessage>, env); // phase 4
      default:
        batch.retryAll(); // unknown queue: keep the messages
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
