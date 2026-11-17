import { catalogFromRecords, jobIneligibility, normalizeCatalog, operationsRow } from './catalog.js';

const fields = ["jobId", "employer", "title", "cycle", "state", "modifiedAt", "closesAt"];

function attributeView(attributes) {
  return Object.fromEntries(fields.map((field) => [field, attributes?.[field] ?? null]));
}

// Build the business view from a catalog. Rows are only the jobs the source
// currently gives us evidence to deliver; excluded carries the explanation
// for every other known job (closed, unobserved, expired).
export function operationsView(catalog, now = new Date()) {
  const normalized = normalizeCatalog(catalog);
  const rows = [];
  const excluded = [];
  for (const job of Object.values(normalized.jobs)) {
    const row = { ...operationsRow(job, now), attributes: attributeView(job.attributes) };
    const reason = jobIneligibility(job, now);
    if (reason === null) rows.push(row);
    else excluded.push({ ...row, reason });
  }
  rows.sort((left, right) => left.jobId.localeCompare(right.jobId));
  excluded.sort((left, right) => left.jobId.localeCompare(right.jobId));
  return {
    product: "岗位信息目录",
    rows,
    excluded,
    source: {
      lastAttemptAt: normalized.source.lastAttemptAt ?? null,
      lastCompletedAt: normalized.source.lastCompletedAt ?? null,
      lastCoverage: normalized.source.lastCoverage ?? null,
      lastError: normalized.source.lastError ?? null,
    },
  };
}

// Read the catalog from a repository, materializing it from the legacy flat
// record list when the state file predates catalog support.
export async function loadCatalog(repository) {
  const catalog = normalizeCatalog(await repository.readCatalog());
  if (Object.keys(catalog.jobs).length) return catalog;
  const records = await repository.read();
  if (!records.length) return catalog;
  return normalizeCatalog(catalogFromRecords(records));
}

// Existing entry point: business state, derived only from the stored catalog.
export async function readOperations(repository, { now = new Date() } = {}) {
  return operationsView(await loadCatalog(repository), now);
}
