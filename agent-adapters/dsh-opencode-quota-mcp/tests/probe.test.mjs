/**
 * 离线协议探针 — dsh-opencode-quota-mcp 接入包。
 *
 * 零网络、零名册：CLI 子进程全部换成 tmp 目录里的假脚本，只验证 MCP 协议面与
 * exit 契约（0/2 正常、1/超时 isError）。跑法：
 *   node --test E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp\tests\probe.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..', '..'); // tests → 本包 → agent-adapters → 仓库根
const SERVER_SCRIPT = path.join(PKG_ROOT, 'tooLib', 'opencode-quota-mcp', 'bin', 'mcp-server.mjs');
const SRC_MCP = path.join(PKG_ROOT, 'tooLib', 'opencode-quota-mcp', 'src', 'mcp.mjs');

const { runQuota, startMcpServer } = await import(pathToFileURL(SRC_MCP).href);

/** 拼一行 JSON-RPC 请求（不带换行）。 */
const line = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

// ---- 夹具目录：放四类假 CLI（成功 / 部分 / 参数错 / 挂死） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-mcp-probe-'));
const FAKE = {
  ok: path.join(TMP, 'fake-ok.mjs'),
  partial: path.join(TMP, 'fake-partial.mjs'),
  bad: path.join(TMP, 'fake-bad.mjs'),
  hang: path.join(TMP, 'fake-hang.mjs'),
};
fs.writeFileSync(FAKE.ok, 'process.stdout.write(JSON.stringify({ ok: true, mode: "single", summary: { total: 1 } }));\n', 'utf8');
fs.writeFileSync(FAKE.partial, 'process.stdout.write("partial"); process.exitCode = 2;\n', 'utf8');
fs.writeFileSync(FAKE.bad, 'process.stderr.write("bad roster"); process.exitCode = 1;\n', 'utf8');
fs.writeFileSync(FAKE.hang, 'setInterval(() => {}, 1000);\n', 'utf8');

test('stdio 三连往返：initialize / tools/list / ping', () => {
  const res = spawnSync(process.execPath, [SERVER_SCRIPT], {
    input: [
      line(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
      line(2, 'tools/list', {}),
      line(3, 'ping', {}),
    ].join('\n') + '\n',
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(res.status, 0, `exit=${res.status} stderr=${res.stderr}`);
  const outLines = res.stdout.split('\n').filter((l) => l.trim() !== '');
  assert.equal(outLines.length, 3);
  const msgs = outLines.map((l) => JSON.parse(l)); // stdout 必须是纯 JSONL
  const [init, tools, pong] = msgs;
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'opencode-quota-mcp');
  assert.ok(init.result.instructions.includes('quota_check'));
  assert.equal(tools.id, 2);
  assert.equal(tools.result.tools.length, 1);
  assert.equal(tools.result.tools[0].name, 'quota_check');
  assert.equal(tools.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(tools.result.tools[0].inputSchema.properties.format.enum, ['table', 'json']);
  assert.equal(pong.id, 3);
  assert.deepEqual(pong.result, {});
  assert.ok(res.stderr.includes('[opencode-quota-mcp]'), `stderr=${res.stderr}`);
});

test('runQuota 退出码契约：0/2 resolve，1 reject，挂死按超时 reject', async () => {
  const ok = await runQuota({ cliPath: FAKE.ok, keysFile: null });
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).ok, true);

  const partial = await runQuota({ cliPath: FAKE.partial, keysFile: null });
  assert.equal(partial.code, 2);
  assert.equal(partial.stdout, 'partial');

  await assert.rejects(
    () => runQuota({ cliPath: FAKE.bad, keysFile: null }),
    /exit 1/,
  );

  await assert.rejects(
    () => runQuota({ cliPath: FAKE.hang, keysFile: null, timeoutMs: 200 }),
    /超时/,
  );
});

test('tools/call 进程内失败 → isError:true 且不掀翻连接', async () => {
  const inStream = new PassThrough();
  const outStream = new PassThrough();
  const server = startMcpServer({ inStream, outStream }, { cliPath: FAKE.bad, keysFile: null });
  try {
    inStream.write(line(11, 'tools/call', { name: 'quota_check', arguments: { format: 'json' } }) + '\n');
    const [chunk] = await once(outStream, 'data', { signal: AbortSignal.timeout(15000) });
    const msg = JSON.parse(String(chunk).trim());
    assert.equal(msg.id, 11);
    assert.equal(msg.result.isError, true);
    assert.ok(/失败/.test(msg.result.content[0].text), `text=${msg.result.content[0].text}`);
    // 连接还活着：再 ping 一次应正常回显
    inStream.write(line(12, 'ping', {}) + '\n');
    const [chunk2] = await once(outStream, 'data', { signal: AbortSignal.timeout(15000) });
    const pong = JSON.parse(String(chunk2).trim());
    assert.equal(pong.id, 12);
  } finally {
    server.close();
  }
});

test('tools/call 成功路径：json 格式透传 CLI 输出', async () => {
  const inStream = new PassThrough();
  const outStream = new PassThrough();
  const server = startMcpServer({ inStream, outStream }, { cliPath: FAKE.ok, keysFile: null });
  try {
    inStream.write(line(21, 'tools/call', { name: 'quota_check', arguments: { format: 'json' } }) + '\n');
    const [chunk] = await once(outStream, 'data', { signal: AbortSignal.timeout(15000) });
    const msg = JSON.parse(String(chunk).trim());
    assert.equal(msg.id, 21);
    assert.notEqual(msg.result.isError, true);
    const parsed = JSON.parse(msg.result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'single');
    assert.equal(parsed.summary.total, 1);
  } finally {
    server.close();
  }
});
