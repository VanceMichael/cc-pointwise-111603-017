export const entryPath = "/careers/jobs";

export function parsePage(response) {
  const items = [...response.text.matchAll(/<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  if (!items.length) throw new Error('source layout contains no records');
  const next = response.text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["jobId"]),
    source: "岗位信息目录",
    observedAt: item["modifiedAt"],
    label: String(item["title"]),
    attributes: structuredClone(item),
  })) };
}
