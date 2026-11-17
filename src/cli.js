import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SourceClient } from './source-client.js';
import { readSourceSnapshot } from './sync.js';
import { operationsView } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.env.COLLECTION_STATE ?? resolve(here, '../var/records.json');
const repository = new RecordRepository(path);
const service = new CollectionService(repository);
const action = process.argv[2] ?? '--help';

function print(value) { console.log(JSON.stringify(value, null, 2)); }

if (action === '--help' || action === '-h') {
  print({
    usage: 'npm start -- sync <来源URL> | ingest [文件] | query [--all] | history [jobId] | explain',
    commands: ['sync', 'ingest', 'query', 'history', 'explain'],
    note: 'sync 读取来源全部页面与覆盖证据；query 只返回当前有依据可投递的岗位',
  });
  process.exit(0);
}
if (action === 'sync') {
  const baseUrl = process.argv[3];
  if (!baseUrl) throw new Error('sync requires a source URL');
  const snapshot = await readSourceSnapshot(new SourceClient(baseUrl));
  const catalog = await service.applyScan({
    observations: snapshot.records,
    complete: snapshot.complete,
    coverage: snapshot.coverage,
    error: snapshot.error,
  });
  print({
    accepted: snapshot.records.length,
    pages: snapshot.pages.length,
    complete: snapshot.complete,
    error: snapshot.error,
    ...operationsView(catalog),
  });
} else if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  print(await service.ingest(records));
} else if (action === 'query') {
  const all = process.argv.includes('--all');
  const source = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : undefined;
  print(await service.query({ source, includeUnavailable: all }));
} else if (action === 'history') {
  print(await service.history({ jobId: process.argv[3] }));
} else if (action === 'explain') {
  print(await service.explain({ source: process.argv[3] }));
} else {
  throw new Error('action must be sync, ingest, query, history or explain');
}
