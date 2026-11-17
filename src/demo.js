import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { readSourceSnapshot } from './sync.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { operationsView } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const client = new SourceClient(source.url);
  const service = new CollectionService(new RecordRepository(join(directory, 'records.json')));
  const opening = await service.applyScan(await readSourceSnapshot(client));
  console.log(JSON.stringify({ step: 'opening', ...operationsView(opening) }, null, 2));
  source.publish('updated');
  const updated = await service.applyScan(await readSourceSnapshot(client));
  console.log(JSON.stringify({ step: 'updated', ...operationsView(updated) }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
