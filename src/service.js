import {
  findRecords,
  mergeRecords,
  normalizeRecord,
} from './records.js';
import {
  applyObservation,
  applySync,
  catalogFromRecords,
  isDeliverable,
  jobIneligibility,
  normalizeCatalog,
  observedState,
  operationsRow,
} from './catalog.js';

export class CollectionService {
  constructor(repository, { now = () => new Date() } = {}) {
    this.repository = repository;
    this.now = now;
  }

  async loadCatalog() {
    const stored = normalizeCatalog(await this.repository.readCatalog());
    // A legacy installation only has the flat record list. Materialize a
    // catalog from it so existing state keeps working after an upgrade.
    if (!Object.keys(stored.jobs).length) {
      const records = await this.repository.read();
      if (!records.length) return stored;
      return normalizeCatalog(catalogFromRecords(records));
    }
    return stored;
  }

  // Legacy structured import: keeps the flat list, but also folds the
  // observations into the catalog so both views agree. It is not a source
  // scan, so it does not claim coverage or a confirmed source read.
  async ingest(inputs) {
    if (!Array.isArray(inputs)) throw new TypeError('ingest input must be an array');
    const accepted = inputs.map(normalizeRecord);
    const current = await this.repository.read();
    const merged = mergeRecords(current, accepted);
    const catalog = structuredClone(await this.loadCatalog());
    const confirmedAt = this.now().toISOString();
    for (const record of accepted) applyObservation(catalog, record, { confirmedAt });
    await this.repository.replaceCatalog(catalog, merged);
    return { accepted: accepted.length, stored: merged.length };
  }

  // Apply one full source scan. The caller decides whether coverage was
  // complete; only a complete scan may downgrade a missing job.
  async applyScan(snapshot) {
    const catalog = await this.loadCatalog();
    const next = applySync(catalog, { checkedAt: this.now().toISOString(), ...snapshot });
    await this.repository.replaceCatalog(next);
    return next;
  }

  // Deliverable list: explicitly open, within validity, last seen by a scan.
  // Pass includeUnavailable to inspect closed / unobserved / expired jobs.
  async query(filters = {}) {
    const catalog = await this.loadCatalog();
    // Legacy imports carry no source open/closed evidence, so there is
    // nothing to judge deliverability by; keep their established behavior.
    const hasSourceEvidence = Object.values(catalog.jobs)
      .some((job) => job.statusObservedAt !== null && job.statusObservedAt !== undefined);
    if (hasSourceEvidence) {
      const now = this.now();
      return Object.values(catalog.jobs)
        .map((job) => operationsRow(job, now))
        .filter((row) => {
          if (filters.source && row.source !== filters.source) return false;
          if (filters.from && Date.parse(row.observedAt) < Date.parse(filters.from)) return false;
          if (filters.to && Date.parse(row.observedAt) > Date.parse(filters.to)) return false;
          if (filters.includeUnavailable) return true;
          return row.deliverable;
        })
        .sort((left, right) => left.jobId.localeCompare(right.jobId));
    }
    return findRecords(await this.repository.read(), filters);
  }

  async available(filters = {}) {
    return (await this.query(filters)).filter((row) => row.deliverable);
  }

  // Every known job with the reason it is or is not deliverable.
  async explain(filters = {}) {
    const catalog = await this.loadCatalog();
    const now = this.now();
    return Object.values(catalog.jobs)
      .filter((job) => !filters.source || job.source === filters.source)
      .map((job) => ({
        ...operationsRow(job, now),
        reason: jobIneligibility(job, now),
        sourceState: observedState({ attributes: job.attributes }),
      }))
      .sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  // Stable job identity with every opening cycle it went through.
  async history(filters = {}) {
    const catalog = await this.loadCatalog();
    const jobs = Object.values(catalog.jobs)
      .filter((job) => !filters.jobId || job.jobId === filters.jobId)
      .filter((job) => !filters.source || job.source === filters.source);
    return {
      source: catalog.source,
      jobs: jobs.map((job) => ({
        jobId: job.jobId,
        employer: job.employer,
        sourceId: job.jobId,
        source: job.source,
        label: job.label,
        status: job.status,
        statusObservedAt: job.statusObservedAt,
        lastConfirmedAt: job.lastConfirmedAt,
        currentCycle: job.currentCycle,
        cycles: [...job.cycles].sort((a, b) => Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt)),
      })),
    };
  }
}
