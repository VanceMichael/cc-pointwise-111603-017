const fields = ["jobId", "employer", "title", "cycle", "state", "modifiedAt", "closesAt"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "岗位信息目录", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
