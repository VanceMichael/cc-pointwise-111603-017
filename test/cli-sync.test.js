import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('CLI sync, query and history expose consistent business state', async () => {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'cli-sync-'));
  const env = { COLLECTION_STATE: join(directory, 'records.json') };
  try {
    const opening = await run(['sync', source.url], env);
    assert.equal(opening.status, 0, opening.stderr);
    const openingView = JSON.parse(opening.stdout);
    assert.equal(openingView.complete, true);
    assert.deepEqual(openingView.rows.map((row) => row.jobId), ['J1']);
    assert.ok(openingView.rows[0].lastConfirmedAt);

    source.publish('updated');
    const closed = await run(['sync', source.url], env);
    assert.equal(closed.status, 0, closed.stderr);
    const closedView = JSON.parse(closed.stdout);
    assert.deepEqual(closedView.rows, [], '明确关闭后查询不再返回该岗位');
    assert.equal(closedView.excluded[0].reason, 'source-closed');

    const query = await run(['query'], env);
    assert.deepEqual(JSON.parse(query.stdout), [], '查询默认只给可投递岗位');

    const all = await run(['query', '--all'], env);
    assert.equal(JSON.parse(all.stdout).length, 1, '--all 可查看不可投递岗位');

    source.publish('reopened');
    const reopened = await run(['sync', source.url], env);
    assert.equal(JSON.parse(reopened.stdout).rows.length, 1);

    const history = await run(['history', 'J1'], env);
    const record = JSON.parse(history.stdout).jobs[0];
    assert.equal(record.currentCycle, 'C2');
    assert.deepEqual(record.cycles.map((cycle) => cycle.cycle), ['C1', 'C2']);
    assert.deepEqual(record.cycles.map((cycle) => cycle.status), ['closed', 'open']);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI sync keeps jobs when coverage is incomplete', async () => {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'cli-incomplete-'));
  const env = { COLLECTION_STATE: join(directory, 'records.json') };
  try {
    await run(['sync', source.url], env);
    source.publish('missing');
    source.failNext('/careers/coverage', 503);
    const result = await run(['sync', source.url], env);
    const view = JSON.parse(result.stdout);
    assert.equal(view.complete, false);
    const ids = view.rows.map((row) => row.jobId);
    assert.ok(ids.includes('J1'), '维护页面不能让已确认开放的岗位不可投递');
    assert.ok(view.source.lastError);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
