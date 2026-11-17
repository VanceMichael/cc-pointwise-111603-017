import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('命令帮助列出现有导入查询与新增同步入口且正常退出', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.ok(help.usage.includes('ingest'));
  assert.ok(help.usage.includes('query'));
  assert.ok(help.usage.includes('sync'));
  assert.deepEqual(help.commands, ['sync', 'ingest', 'query', 'history', 'explain']);
});

test('未知动作明确失败而不执行默认查询', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'invalid-action'], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sync, ingest, query/);
});
