import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('explicit job closure preserves job and cycle identity independently of fetch failure', async () => {
  const opened = (await observe()).records[0].attributes;
  const closed = (await observe('updated')).records[0].attributes;
  assert.equal(opened.jobId, closed.jobId);
  assert.equal(opened.cycle, closed.cycle);
  assert.equal(closed.state, 'closed');
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.failNext(entryPath, 503);
    assert.equal((await fetch(new URL(entryPath, source.url))).status, 503);
    const coverage = await (await fetch(`${source.url}/careers/coverage`)).json();
    assert.equal(coverage.complete, true);
  } finally { await source.close(); }
});
