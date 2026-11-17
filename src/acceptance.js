import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { readSourceSnapshot } from './sync.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const client = new SourceClient(source.url);
  const repository = new RecordRepository(join(directory, 'records.json'));
  const service = new CollectionService(repository);

  const opening = await service.applyScan(await readSourceSnapshot(client));
  assert.ok(Object.keys(opening.jobs).length > 0, '初始来源须有可接收的业务岗位');
  const firstView = await readOperations(repository);
  assert.equal(firstView.rows.length, Object.keys(opening.jobs).length);
  assert.ok(firstView.rows.every((row) => row.deliverable && row.status === 'open' && row.lastConfirmedAt));

  // Replaying the same page must not duplicate the job.
  const replay = await service.applyScan(await readSourceSnapshot(client));
  assert.equal(Object.keys(replay.jobs).length, Object.keys(opening.jobs).length, '重放不重复保存');

  // Explicit closure withdraws the job from the deliverable list.
  source.publish('updated');
  const closed = await service.applyScan(await readSourceSnapshot(client));
  const closedView = await readOperations(repository);
  assert.equal(closedView.rows.length, 0, '明确关闭后不再可投递');
  assert.equal(closedView.excluded[0].reason, 'source-closed');

  // An old page replay must not undo a newer closure.
  source.publish('replayed');
  const replayed = await service.applyScan(await readSourceSnapshot(client));
  assert.equal(replayed.jobs[Object.keys(replayed.jobs)[0]].status, 'closed', '旧页面重放不能推翻较新的关闭');

  // Re-opening keeps the job identity and both cycles.
  source.publish('reopened');
  const reopened = await service.applyScan(await readSourceSnapshot(client));
  const job = reopened.jobs[Object.keys(reopened.jobs)[0]];
  assert.equal(Object.keys(reopened.jobs).length, 1, '重新开放不新建职位');
  assert.equal(job.cycles.length, 2, '不同开放周期保留历史');
  const reopenedView = await readOperations(repository);
  assert.equal(reopenedView.rows.length, 1);
  assert.equal(reopenedView.rows[0].cycle, 'C2');

  console.log(JSON.stringify({
    jobs: Object.keys(reopened.jobs).length,
    cycles: job.cycles.length,
    deliverable: reopenedView.rows.length,
    lastConfirmedAt: reopenedView.rows[0].lastConfirmedAt,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
