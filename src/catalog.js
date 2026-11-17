// Catalog state for collected jobs.
//
// A job is identified by employer + jobId (jobId is stable only inside one
// employer). One job can have several opening cycles; every cycle keeps its
// own history, so a re-opened job stays the same business job instead of
// becoming a duplicate.
//
// Status values deliberately keep three different meanings apart:
//   open       - the source explicitly said the job is open.
//   closed     - the source explicitly withdrew the job.
//   unobserved - a complete scan did not see the job; absence is not a
//                withdrawal, it only means we currently have no evidence.
//
// Nothing is ever deleted: a job that is closed or unobserved remains stored
// with its cycles and can be reopened under the same identity.

export const OPEN_STATE = 'open';
export const CLOSED_STATE = 'closed';
export const UNOBSERVED_STATE = 'unobserved';

const stateRank = { [UNOBSERVED_STATE]: 0, [OPEN_STATE]: 1, [CLOSED_STATE]: 2 };

function validTime(value) {
  return Number.isFinite(Date.parse(value));
}

export function observedState(record) {
  const state = record?.attributes?.state;
  return state === OPEN_STATE || state === CLOSED_STATE ? state : null;
}

export function observedCycle(record) {
  const cycle = record?.attributes?.cycle;
  return cycle === undefined || cycle === null || String(cycle).trim() === ''
    ? null
    : String(cycle).trim();
}

export function isValidUntil(attributes, now = new Date()) {
  const closesAt = attributes?.closesAt;
  if (!closesAt) return true;
  // A malformed validity field is not proof of validity.
  if (!validTime(closesAt)) return false;
  return now.getTime() <= Date.parse(closesAt);
}

export function jobKey(record) {
  const employer = record?.attributes?.employer ?? '';
  return `${String(employer)}\u0000${record.sourceId}`;
}

export function jobIdentity(job) {
  return `${job.employer ?? ''}:${job.jobId}`;
}

function emptyCatalog() {
  return {
    version: 1,
    source: {
      lastAttemptAt: null,
      lastCompletedAt: null,
      lastCoverage: null,
      lastError: null,
    },
    jobs: {},
  };
}

// Older or partial state files are still readable.
export function normalizeCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCatalog();
  const base = emptyCatalog();
  const jobs = {};
  if (value.jobs && typeof value.jobs === 'object' && !Array.isArray(value.jobs)) {
    for (const [key, job] of Object.entries(value.jobs)) {
      if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
      jobs[key] = {
        ...job,
        jobId: job.jobId ?? key.split('\u0000').at(-1),
        employer: job.employer ?? null,
        cycles: Array.isArray(job.cycles)
          ? job.cycles.map((entry) => ({ ...entry, history: Array.isArray(entry.history) ? entry.history : [] }))
          : [],
      };
    }
  }
  return {
    version: 1,
    source: { ...base.source, ...(value.source ?? {}) },
    jobs,
  };
}

function newJob(record, observedAt) {
  const attributes = structuredClone(record.attributes ?? {});
  return {
    jobId: record.sourceId,
    employer: attributes.employer ?? null,
    source: record.source,
    label: record.label ?? null,
    status: UNOBSERVED_STATE,
    statusObservedAt: null,
    lastConfirmedAt: null,
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    lastCheckedAt: null,
    unobservedAt: null,
    currentCycle: null,
    closesAt: attributes.closesAt ?? null,
    attributes,
    cycles: [],
  };
}

function findCycle(job, cycle) {
  return job.cycles.find((entry) => entry.cycle === cycle);
}

// Select the current opening cycle. An explicit status is stronger evidence
// than a mere sighting, and among explicit statuses the newest confirmation
// wins. On an exact tie the more decisive state wins. Cycles are never thrown
// away, so a re-open keeps the previous opening period as history.
function selectCurrentCycle(job) {
  let best = null;
  for (const entry of job.cycles) {
    if (!best) { best = entry; continue; }
    const entryTime = Date.parse(entry.statusObservedAt ?? entry.lastObservedAt ?? 0);
    const bestTime = Date.parse(best.statusObservedAt ?? best.lastObservedAt ?? 0);
    if (entryTime > bestTime) best = entry;
    else if (entryTime === bestTime && stateRank[entry.status] > stateRank[best.status]) best = entry;
  }
  return best;
}

function refreshJob(job) {
  const current = selectCurrentCycle(job);
  if (!current) return job;
  job.currentCycle = current.cycle;
  job.status = current.status;
  job.statusObservedAt = current.statusObservedAt;
  job.lastConfirmedAt = current.lastConfirmedAt ?? current.statusObservedAt;
  job.closesAt = current.closesAt ?? null;
  if (current.attributes) {
    job.attributes = structuredClone(current.attributes);
    job.label = current.attributes.title ?? job.label;
    job.employer = current.attributes.employer ?? job.employer;
  }
  // A complete scan that did not see the job is newer evidence than any
  // explicit status we still hold. Only a later sighting (which clears
  // unobservedAt) may move the job back to open.
  if (job.unobservedAt) job.status = UNOBSERVED_STATE;
  return job;
}

function noteObservation(entry, record, state, observedAt, confirmedAt) {
  const attributes = structuredClone(record.attributes ?? {});
  const observedTime = Date.parse(observedAt);
  const previousSighting = entry.lastObservedAt ? Date.parse(entry.lastObservedAt) : null;
  const isLatestSighting = previousSighting === null || observedTime >= previousSighting;
  if (!entry.firstObservedAt || observedTime < Date.parse(entry.firstObservedAt)) {
    entry.firstObservedAt = observedAt;
  }
  if (isLatestSighting) {
    entry.lastObservedAt = observedAt;
    entry.attributes = attributes;
    entry.closesAt = attributes.closesAt ?? entry.closesAt ?? null;
  }
  if (!state) return;
  // Only the newest sighting may confirm or change the explicit state. An
  // older page replay is never new evidence.
  if (!isLatestSighting) return;
  const previous = entry.statusObservedAt ? Date.parse(entry.statusObservedAt) : null;
  const candidate = observedTime;
  // Seeing the same explicit state again confirms it as of this scan, even
  // when the source's own modifiedAt did not move. Only transitions are kept
  // in history so repeated scans do not grow it without bound.
  if (entry.status === state) {
    entry.lastConfirmedAt = confirmedAt ?? observedAt;
    return;
  }
  // A stale page carrying a different state cannot undo the confirmation
  // already held (an old page replay must not reopen a newer closure). On an
  // exact timestamp tie an explicit closure wins over an explicit opening.
  const accepted = previous === null || candidate > previous
    || (candidate === previous && state === CLOSED_STATE);
  if (!accepted) return;
  entry.status = state;
  entry.statusObservedAt = observedAt;
  entry.lastConfirmedAt = confirmedAt ?? observedAt;
  if (state === CLOSED_STATE) entry.closedAt = observedAt;
  else if (previous !== null) entry.reopenedAt = observedAt;
  entry.history = Array.isArray(entry.history) ? entry.history : [];
  entry.history.push({ state, observedAt, confirmedAt: entry.lastConfirmedAt });
}

export function applyObservation(catalog, record, { confirmedAt = null } = {}) {
  const key = jobKey(record);
  const observedAt = record.observedAt;
  let job = catalog.jobs[key];
  if (!job) {
    job = newJob(record, observedAt);
    catalog.jobs[key] = job;
  }
  const state = observedState(record);
  // A record without a cycle still belongs to the known current cycle; a
  // brand new job without cycle gets a synthetic stable segment.
  const cycle = observedCycle(record) ?? job.currentCycle ?? 'uncycled';
  let entry = findCycle(job, cycle);
  if (!entry) {
    entry = {
      cycle,
      status: UNOBSERVED_STATE,
      statusObservedAt: null,
      lastConfirmedAt: null,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      closesAt: record.attributes?.closesAt ?? null,
      attributes: structuredClone(record.attributes ?? {}),
      history: [],
    };
    job.cycles.push(entry);
  }
  const previousSighting = job.lastObservedAt ? Date.parse(job.lastObservedAt) : null;
  noteObservation(entry, record, state, observedAt, confirmedAt);
  if (!job.firstObservedAt || Date.parse(observedAt) < Date.parse(job.firstObservedAt)) {
    job.firstObservedAt = observedAt;
  }
  const isLatestSighting = previousSighting === null
    || Date.parse(observedAt) >= previousSighting;
  if (isLatestSighting) {
    job.lastObservedAt = observedAt;
    job.label = record.label ?? job.label;
  }
  // Only an observation newer than the complete scan that missed the job can
  // clear "unobserved". An older page replay is not current evidence.
  if (!job.unobservedAt || Date.parse(observedAt) >= Date.parse(job.unobservedAt)) {
    job.unobservedAt = null;
  }
  job.source = record.source ?? job.source;
  // A sighting without an explicit state is not fresh open/closed evidence;
  // do not let it resurrect the previous explicit status.
  if (state !== null || job.currentCycle === null) refreshJob(job);
  return job;
}

// Apply a full sync batch. `complete` records whether the scan had positive
// coverage evidence (every page fetched and the source said the crawl was
// complete). Only then may a missing job be downgraded to unobserved; an
// explicit closure always stays closed.
export function applySync(catalog, {
  observations,
  records,
  complete = false,
  checkedAt = new Date().toISOString(),
  coverage = null,
  error = null,
} = {}) {
  const next = normalizeCatalog(structuredClone(catalog));
  const incoming = observations ?? records ?? [];
  // Source bookkeeping is monotonic: replaying an older scan must not make a
  // newer complete coverage confirmation look older than it is.
  const laterThan = (previous, candidate) => {
    if (!previous) return candidate;
    return Date.parse(candidate) >= Date.parse(previous) ? candidate : previous;
  };
  const isLatestScan = !next.source.lastAttemptAt
    || Date.parse(checkedAt) >= Date.parse(next.source.lastAttemptAt);
  next.source.lastAttemptAt = laterThan(next.source.lastAttemptAt, checkedAt);
  // Coverage/error describe the latest attempt; a replayed old attempt must
  // not overwrite the newer one.
  if (isLatestScan) {
    next.source.lastError = error;
    next.source.lastCoverage = coverage;
  }

  for (const record of incoming) {
    applyObservation(next, record, { confirmedAt: checkedAt });
  }

  if (complete) {
    const seen = new Set(incoming.map(jobKey));
    for (const [key, job] of Object.entries(next.jobs)) {
      if (seen.has(key)) {
        job.lastCheckedAt = laterThan(job.lastCheckedAt, checkedAt);
        continue;
      }
      // An explicit closure is a withdrawal and never becomes "unobserved".
      if (job.status === CLOSED_STATE) {
        job.lastCheckedAt = laterThan(job.lastCheckedAt, checkedAt);
        continue;
      }
      // A scan older than the one that last checked this job must not
      // downgrade it, even if it is replayed later.
      const checked = Date.parse(checkedAt);
      if (job.lastCheckedAt && Date.parse(job.lastCheckedAt) > checked) continue;
      job.status = UNOBSERVED_STATE;
      job.unobservedAt = checkedAt;
      job.lastCheckedAt = checkedAt;
    }
    next.source.lastCompletedAt = laterThan(next.source.lastCompletedAt, checkedAt);
  }
  return next;
}

export function isDeliverable(job, now = new Date()) {
  return job.status === OPEN_STATE && isValidUntil(job.attributes, now);
}

export function jobIneligibility(job, now = new Date()) {
  if (job.status === CLOSED_STATE) return 'source-closed';
  if (job.status === UNOBSERVED_STATE) return 'not-observed';
  if (job.status === OPEN_STATE && !isValidUntil(job.attributes, now)) return 'expired';
  if (job.status !== OPEN_STATE) return 'unknown-state';
  return null;
}

export function operationsRow(job, now = new Date()) {
  const attributes = Object.fromEntries(
    ['jobId', 'employer', 'title', 'cycle', 'state', 'modifiedAt', 'closesAt']
      .map((field) => [field, job.attributes?.[field] ?? null]),
  );
  return {
    sourceId: job.jobId,
    jobId: job.jobId,
    employer: job.employer,
    sourceKey: jobIdentity(job),
    source: job.source,
    label: job.label,
    observedAt: job.lastObservedAt,
    // Source timestamp of the explicit open/closed evidence currently held.
    statusObservedAt: job.statusObservedAt,
    // When our scan last accepted that evidence from the source. A scan that
    // did not see the job (unobserved) never updates this.
    lastConfirmedAt: job.lastConfirmedAt ?? job.statusObservedAt,
    lastCheckedAt: job.lastCheckedAt,
    status: job.status,
    cycle: job.currentCycle,
    closesAt: job.closesAt,
    deliverable: isDeliverable(job, now),
    attributes,
  };
}

export function catalogFromRecords(records) {
  const catalog = emptyCatalog();
  for (const record of [...records].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))) {
    applyObservation(catalog, record);
  }
  return catalog;
}
