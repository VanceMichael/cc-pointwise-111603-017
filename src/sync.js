import { entryPath, parsePage } from './adapter.js';

export const coveragePath = '/careers/coverage';
const MAX_PAGES = 100;

function resolvePageUrl(href, baseUrl) {
  const address = new URL(href, baseUrl);
  if (address.origin !== new URL(baseUrl).origin) throw new Error('source origin changed');
  return address;
}

async function readCoverage(client) {
  try {
    const response = await client.read(coveragePath);
    const value = JSON.parse(response.text);
    if (!value || typeof value !== 'object') throw new Error('coverage response is not an object');
    return { complete: value.complete === true, raw: value };
  } catch (error) {
    return { complete: false, raw: null, error: error.message };
  }
}

// Read the whole source: the entry page plus every rel=next page. Coverage is
// only "complete" when every page was fetched, the last page had no next link,
// and the source's coverage endpoint explicitly said the crawl was complete.
// A failed page, a failed coverage check, a loop, or a missing positive
// coverage answer all leave the scan incomplete, so absence must not be read
// as withdrawal.
export async function readSourceSnapshot(client, { entry = entryPath } = {}) {
  const pages = [];
  const records = [];
  const seen = new Set();
  let next = resolvePageUrl(entry, client.baseUrl).href;
  let failure = null;

  while (next && pages.length < MAX_PAGES) {
    if (seen.has(next)) { failure = 'pagination loop'; break; }
    seen.add(next);
    let response;
    try {
      response = await client.read(next);
    } catch (error) {
      failure = error.message;
      break;
    }
    let page;
    try {
      page = parsePage(response, { allowEmpty: pages.length > 0 });
    } catch (error) {
      failure = error.message;
      break;
    }
    pages.push(next);
    records.push(...page.records);
    if (!page.next) { next = null; continue; }
    try {
      next = resolvePageUrl(page.next, next).href;
    } catch (error) {
      failure = error.message;
      next = null;
    }
  }
  if (pages.length >= MAX_PAGES && next) failure = failure ?? 'too many pages';

  const coverage = await readCoverage(client);
  const complete = !failure && !next && coverage.complete;
  return {
    records,
    pages,
    coverage: coverage.raw ?? { complete: false, error: coverage.error ?? null },
    complete,
    error: failure ?? (coverage.complete ? null : coverage.error ?? 'source coverage incomplete'),
  };
}
