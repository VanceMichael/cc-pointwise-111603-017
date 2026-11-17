export const schema = Object.freeze({
  "product": "岗位信息目录",
  "entity": "招聘岗位",
  "identity": "employer + jobId",
  "statuses": ["open", "closed", "unobserved"],
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "招聘岗位的来源身份、开放状态、有效期与撤回同步"
});
