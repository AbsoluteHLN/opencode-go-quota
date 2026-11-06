#!/usr/bin/env node
/**
 * stdio MCP 入口薄壳 — opencode Go 配额查询。
 *
 * 用法：
 *   node mcp-server.mjs [--keys-file <名册.txt>]
 *
 * - --keys-file：多 key 名册路径（一人一行，`|` 分隔标签与 key）。
 *   缺省用包根的 opencode-go-keys.txt。路径只透传给 CLI 子进程，server 自身不读名册内容。
 * - 协议与工具面在 ../src/mcp.mjs；本文件只做 argv 解析、诊断打印与退出处理。
 * - stdout 只跑 JSON-RPC 2.0 行协议；诊断一律走 stderr。
 */
import { startMcpServer, describeSetup } from '../src/mcp.mjs';

const TAG = '[opencode-quota-mcp]';

function parseArgv(argv) {
  const parsed = { keysFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keys-file') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        process.stderr.write(`${TAG} --keys-file 需要一个路径参数\n`);
        process.exit(1);
      }
      parsed.keysFile = value;
      i += 1;
    } else if (arg.startsWith('--keys-file=')) {
      const value = arg.slice('--keys-file='.length);
      if (value === '') {
        process.stderr.write(`${TAG} --keys-file 需要一个路径参数\n`);
        process.exit(1);
      }
      parsed.keysFile = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write('usage: node mcp-server.mjs [--keys-file <roster.txt>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`${TAG} 未识别的参数 ${JSON.stringify(arg)}，忽略\n`);
    }
  }
  return parsed;
}

const { keysFile } = parseArgv(process.argv.slice(2));

// 诊断行只含路径与存在性布尔，绝不包含名册内容（名册里有真 key）。
process.stderr.write(`${TAG} ${describeSetup(keysFile)}\n`);

startMcpServer({}, { keysFile });

// 宿主关闭 stdin（正常收摊）→ 干净退出；SIGTERM/SIGINT → 干净退出。
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
