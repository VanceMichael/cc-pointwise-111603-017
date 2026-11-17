import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

async function readDocument(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(value.records)) throw new Error('record file has no records array');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [] };
    throw error;
  }
}

async function writeDocument(path, document) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}

export class RecordRepository {
  constructor(path) { this.path = path; }

  async read() {
    return (await readDocument(this.path)).records;
  }

  async replace(records) {
    const document = await readDocument(this.path);
    await writeDocument(this.path, { ...document, records });
  }

  // The collected-job catalog is kept next to the legacy record list in the
  // same document so one atomic write commits both views of the same batch.
  async readCatalog() {
    return (await readDocument(this.path)).catalog ?? null;
  }

  async replaceCatalog(catalog, records = null) {
    const document = await readDocument(this.path);
    await writeDocument(this.path, {
      ...document,
      ...(records ? { records } : {}),
      catalog,
    });
  }
}
