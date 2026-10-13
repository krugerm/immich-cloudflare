import { describe, expect, it } from 'vitest';
import { queueKind } from '../src/index';
import { PROCESS_MAX_RETRIES } from '../src/process/consumer';
import wranglerRaw from '../wrangler.jsonc?raw';

describe('queueKind', () => {
  it('maps the default queue names', () => {
    expect(queueKind('asset-process')).toBe('process');
    expect(queueKind('asset-process-dlq')).toBe('process-dlq');
    expect(queueKind('asset-backup')).toBe('backup');
    expect(queueKind('asset-ml')).toBe('ml');
  });

  it('keeps working when a deployment renames or suffixes the queues', () => {
    expect(queueKind('asset-process-e2e')).toBe('process');
    expect(queueKind('asset-process-dlq-e2e')).toBe('process-dlq');
    expect(queueKind('photos_backup')).toBe('backup');
    expect(queueKind('immich-ml-prod')).toBe('ml');
  });

  it('wrangler.jsonc: every consumer has a handler, none uses a dead-letter queue, process retries match the code', () => {
    const consumers: Array<{ queue: string; max_retries?: number; dead_letter_queue?: string }> = JSON.parse(
      wranglerRaw.replace(/^\s*\/\/.*$/gm, ''),
    ).queues.consumers;
    for (const c of consumers) {
      expect(queueKind(c.queue)).toBeDefined();
      expect(c.dead_letter_queue).toBeUndefined(); // a renamed deployment would point at another deployment's queue
    }
    expect(consumers.find((c) => queueKind(c.queue) === 'process')?.max_retries).toBe(PROCESS_MAX_RETRIES);
  });

  it('leaves the backup dead-letter queue and unknown names to the default branch', () => {
    expect(queueKind('asset-backup-dlq')).toBeUndefined();
    expect(queueKind('html-renderer')).toBeUndefined(); // "ml" only as a whole word
    expect(queueKind('something')).toBeUndefined();
  });
});
