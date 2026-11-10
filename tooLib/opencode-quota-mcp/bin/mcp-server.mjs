#!/usr/bin/env node
/**
 * stdio MCP 入口薄壳 — opencode Go 配额查询。
 *
 * 用法：
 *   node mcp-server.mjs [--cli <cli.mjs>] [--keys-file <名册.txt>]
 *
 * - --keys-file：多 key 名册路径（一人一行，`|` 分隔标签与 key）。
 *   缺省用包根的 opencode-go-keys.txt（不存在则交给 CLI 自动发现）。路径只透传给 CLI 子进程，
 *   server 自身不读名册内容。
 * - --cli：指定 CLI 脚本路径（跨机安装时 CLI 不在默认相对位置时用）。缺省用同包 bin/opencode-go-quota.mjs。
 * - 协议与工具面在 ../src/mcp.mjs；本文件只做 argv 解析、诊断打印与退出处理。
 * - stdout 只跑 JSON-RPC 2.0 行协议；诊断一律走 stderr。
 */
import { startMcpServer, describeSetup, resolveKeysFile } from '../src/mcp.mjs';

const TAG = '[opencode-quota-mcp]';

function parseArgv(argv) {
  const parsed = { keysFile: undefined, cliPath: undefined };
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
    } else if (arg === '--cli') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        process.stderr.write(`${TAG} --cli 需要一个路径参数\n`);
        process.exit(1);
      }
      parsed.cliPath = value;
      i += 1;
    } else if (arg.startsWith('--cli=')) {
      const value = arg.slice('--cli='.length);
      if (value === '') {
        process.stderr.write(`${TAG} --cli 需要一个路径参数\n`);
        process.exit(1);
      }
      parsed.cliPath = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write('usage: node mcp-server.mjs [--cli PATH] [--keys-file <roster.txt>]\n');
      process.exit(0);
    } else {
      process.stderr.write(`${TAG} 未识别的参数 ${JSON.stringify(arg)}，忽略\n`);
    }
  }
  return parsed;
}

const { keysFile, cliPath } = parseArgv(process.argv.slice(2));

// 真正透传给 CLI 的名册路径（未显式指定时：默认名册存在才用，否则交给 CLI 自动发现）。
// 诊断行与实际行为用同一个解析结果，避免"写着自动发现、实际硬传路径"的口径漂移。
const effectiveKeysFile = resolveKeysFile({ keysFile });

// CLI 脚本路径（--cli 显式指定才用，否则 server 用同包默认副本）。
const effectiveCliPath = cliPath ?? undefined;

// 诊断行只含路径与存在性布尔，绝不包含名册内容（名册里有真 key）。
process.stderr.write(`${TAG} ${describeSetup(effectiveKeysFile, effectiveCliPath)}\n`);

startMcpServer({}, { keysFile: effectiveKeysFile, cliPath: effectiveCliPath });

// 宿主关闭 stdin（正常收摊）→ 干净退出；SIGTERM/SIGINT → 干净退出。
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
