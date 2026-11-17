import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { readSourceSnapshot } from '../src/sync.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { readOperations } from '../src/operations.js';
import { applySync, normalizeCatalog } from '../src/catalog.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);
const NOW = new Date('2026-11-17T12:00:00Z');

async function withSource(run) {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'sync-'));
  try {
    const repository = new RecordRepository(join(directory, 'records.json'));
    const service = new CollectionService(repository, { now: () => NOW });
    await run({ source, repository, service, client: new SourceClient(source.url) });
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const jobOf = (catalog) => Object.values(catalog.jobs)[0];

test('page replay cannot undo a newer explicit closure; query hides closed jobs', async () => {
  await withSource(async ({ source, repository, service, client }) => {
    await service.applyScan(await readSourceSnapshot(client));
    source.publish('updated');
    const closed = await service.applyScan(await readSourceSnapshot(client));
    assert.equal(jobOf(closed).status, 'closed');

    source.publish('replayed');
    const replayed = await service.applyScan(await readSourceSnapshot(client));
    assert.equal(jobOf(replayed).status, 'closed', '旧页面重放不能推翻较新的关闭');
    assert.equal(jobOf(replayed).statusObservedAt, '2026-11-16T09:00:00Z');

    const view = await readOperations(repository);
    assert.deepEqual(view.rows, [], '明确关闭的岗位不在可投递列表');
    assert.equal(view.excluded.length, 1);
    assert.equal(view.excluded[0].reason, 'source-closed');
  });
});

test('a complete scan that misses a job marks it unobserved without withdrawing it', async () => {
  await withSource(async ({ source, service, client }) => {
    await service.applyScan(await readSourceSnapshot(client));
    source.publish('missing');
    const catalog = await service.applyScan(await readSourceSnapshot(client));
    const job = catalog.jobs[Object.keys(catalog.jobs)[0]];
    assert.equal(job.status, 'unobserved', '完整采集缺席只表示暂未观察到');
    assert.notEqual(job.status, 'closed');
    assert.ok(job.unobservedAt);
    // The explicit evidence timestamp is preserved even though it is stale.
    assert.equal(job.statusObservedAt, '2026-11-16T08:00:00Z');
  });
});

test('incomplete coverage never downgrades a missing job', async () => {
  await withSource(async ({ source, service, client }) => {
    await service.applyScan(await readSourceSnapshot(client));
    // The source says it is under maintenance: coverage is not complete.
    source.failNext('/careers/coverage', 503);
    const catalog = await service.applyScan(await readSourceSnapshot(client));
    const job = jobOf(catalog);
    assert.equal(job.status, 'open', '覆盖不完整时不能把缺席当作撤回');
    assert.equal(catalog.source.lastCompletedAt, catalog.source.lastAttemptAt);
    assert.match(catalog.source.lastError, /503|coverage/);
  });
});

test('a failed page or missing coverage answer makes the scan incomplete', async () => {
  await withSource(async ({ source, client }) => {
    source.failNext('/careers/jobs', 503);
    const failedPage = await readSourceSnapshot(client);
    assert.equal(failedPage.complete, false);
    assert.match(failedPage.error, /503/);

    source.publish('partial');
    const partial = await readSourceSnapshot(client);
    assert.equal(partial.complete, false, '来源自称覆盖不完整时采集不完整');
  });
});

test('multi-page crawl is complete only when every page is read', async () => {
  await withSource(async ({ source, client }) => {
    source.publish('paged');
    const snapshot = await readSourceSnapshot(client);
    assert.equal(snapshot.pages.length, 2);
    assert.deepEqual(snapshot.records.map((record) => record.sourceId), ['J1', 'J2']);
    assert.equal(snapshot.complete, true);

    source.failNext('/careers/jobs?page=2', 503);
    const partial = await readSourceSnapshot(client);
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.records.map((record) => record.sourceId), ['J1']);
  });
});

test('re-opening keeps one job identity and both cycles', async () => {
  await withSource(async ({ source, repository, service, client }) => {
    await service.applyScan(await readSourceSnapshot(client));
    source.publish('updated');
    await service.applyScan(await readSourceSnapshot(client));
    source.publish('reopened');
    const catalog = await service.applyScan(await readSourceSnapshot(client));

    assert.equal(Object.keys(catalog.jobs).length, 1, '重新开放不新建职位');
    const job = jobOf(catalog);
    assert.equal(job.status, 'open');
    assert.equal(job.currentCycle, 'C2');
    assert.deepEqual(job.cycles.map((entry) => entry.cycle), ['C1', 'C2'], '保留不同开放周期历史');
    assert.equal(job.cycles[0].status, 'closed');
    assert.equal(job.cycles[1].status, 'open');

    const view = await readOperations(repository);
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].jobId, 'J1');
    assert.equal(view.rows[0].cycle, 'C2');
  });
});

test('expired validity is not deliverable even while explicitly open', async () => {
  await withSource(async ({ source, repository, service, client }) => {
    source.publish('expired');
    const catalog = await service.applyScan(await readSourceSnapshot(client));
    assert.equal(jobOf(catalog).status, 'open');
    const view = await readOperations(repository);
    assert.deepEqual(view.rows, [], '过有效期的岗位不可投递');
    assert.equal(view.excluded[0].reason, 'expired');
  });
});

test('a newer explicit re-open is accepted, an older observation is ignored', () => {
  const base = normalizeCatalog(null);
  const make = (state, modifiedAt, cycle = 'C1') => ({
    sourceId: 'J1', source: '岗位信息目录', observedAt: modifiedAt, label: '资料员',
    attributes: { jobId: 'J1', employer: 'E1', title: '资料员', cycle, state, modifiedAt, closesAt: null },
  });
  const closed = applySync(base, {
    observations: [make('open', '2026-11-16T08:00:00Z'), make('closed', '2026-11-16T09:00:00Z')],
    complete: true,
    checkedAt: '2026-11-16T10:00:00Z',
  });
  assert.equal(jobOf(closed).status, 'closed');
  const stale = applySync(closed, { observations: [make('open', '2026-11-16T07:00:00Z')], complete: true, checkedAt: '2026-11-17T10:00:00Z' });
  assert.equal(jobOf(stale).status, 'closed', '较旧的开放在关闭之后不能生效');
  const newer = applySync(closed, { observations: [make('open', '2026-11-18T08:00:00Z', 'C2')], complete: true, checkedAt: '2026-11-18T10:00:00Z' });
  assert.equal(jobOf(newer).status, 'open');
  assert.equal(jobOf(newer).cycles.length, 2);
});

test('unobserved is sticky against stale replays and never overrides a closure', () => {
  const make = (state, modifiedAt, cycle = 'C1') => ({
    sourceId: 'J1', source: '岗位信息目录', observedAt: modifiedAt, label: '资料员',
    attributes: { jobId: 'J1', employer: 'E1', title: '资料员', cycle, state, modifiedAt, closesAt: null },
  });
  let catalog = applySync(normalizeCatalog(null), {
    observations: [make('open', '2026-11-16T08:00:00Z')], complete: true, checkedAt: '2026-11-17T09:00:00Z',
  });
  catalog = applySync(catalog, { observations: [], complete: true, checkedAt: '2026-11-18T09:00:00Z' });
  assert.equal(jobOf(catalog).status, 'unobserved');

  // Replaying the old opening must not resurrect the job.
  catalog = applySync(catalog, {
    observations: [make('open', '2026-11-16T08:00:00Z')], complete: true, checkedAt: '2026-11-19T09:00:00Z',
  });
  assert.equal(jobOf(catalog).status, 'unobserved', '旧观察不能让暂未观察到的岗位重新可投递');

  // A fresh sighting does bring it back.
  catalog = applySync(catalog, {
    observations: [make('open', '2026-11-20T08:00:00Z')], complete: true, checkedAt: '2026-11-20T09:00:00Z',
  });
  assert.equal(jobOf(catalog).status, 'open');

  // Once explicitly closed, a missing job stays closed.
  catalog = applySync(catalog, {
    observations: [make('closed', '2026-11-21T08:00:00Z')], complete: true, checkedAt: '2026-11-21T09:00:00Z',
  });
  catalog = applySync(catalog, { observations: [], complete: true, checkedAt: '2026-11-22T09:00:00Z' });
  assert.equal(jobOf(catalog).status, 'closed', '明确撤回不因缺席变成暂未观察到');
});

test('an old complete scan replayed later cannot downgrade newer state or coverage', () => {
  const make = (state, modifiedAt) => ({
    sourceId: 'J1', source: '岗位信息目录', observedAt: modifiedAt, label: '资料员',
    attributes: { jobId: 'J1', employer: 'E1', title: '资料员', cycle: 'C1', state, modifiedAt, closesAt: null },
  });
  const newer = applySync(normalizeCatalog(null), {
    observations: [make('open', '2026-11-16T08:00:00Z')],
    complete: true,
    checkedAt: '2026-11-18T10:00:00Z',
    coverage: { complete: true },
  });
  const replayed = applySync(newer, {
    observations: [make('open', '2026-11-16T08:00:00Z')],
    complete: true,
    checkedAt: '2026-11-17T10:00:00Z',
    coverage: { complete: true },
  });
  assert.equal(replayed.source.lastCompletedAt, '2026-11-18T10:00:00Z', '覆盖确认时间不倒退');
  assert.equal(replayed.source.lastAttemptAt, '2026-11-18T10:00:00Z');
  assert.equal(jobOf(replayed).status, 'open');
  assert.equal(jobOf(replayed).lastCheckedAt, '2026-11-18T10:00:00Z', '确认时间不因重放倒退');
});
