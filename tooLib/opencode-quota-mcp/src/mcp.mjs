/**
 * MCP stdio 服务面（JSON-RPC 2.0）— opencode Go 配额查询。
 *
 * 协议形状照抄同仓 tooLib/web-search-mcp/src/mcp.mjs —— 那份已在 DSH 上验证可用。
 *
 * 设计：不重造 quota 逻辑。每次工具调用 spawn 同包 bin/opencode-go-quota.mjs（v1.1.0 CLI），
 * 复用它的全部 key 解析链（名册 → --key → env → auth.json → dsh credentials → minimax config）
 * 与渲染（人读表格 / 结构化 JSON，key 一律掩码）。CLI 的 exit 0（全成功）与
 * exit 2（部分 key 失败、结果仍完整）都按正常结果返回；exit 1（参数/名册文件错误）
 * 与超时才按 MCP isError 上报。
 *
 * instructions 会被宿主注入系统提示（### MCP server: opencode 段），
 * 所以「什么时候该查配额」写在这里，不写进人设：能力与纪律跟着工具走，换宿主也不丢。
 */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'opencode';
const SERVER_VERSION = '1.0.0';

/** CLI 副本（与 src/ 同包：tooLib/opencode-quota-mcp/bin/opencode-go-quota.mjs） */
const CLI_PATH = fileURLToPath(new URL('../bin/opencode-go-quota.mjs', import.meta.url));
/** 包根名册（用户往这里填各人 key；未显式指定 --keys-file 时的默认名册） */
const DEFAULT_KEYS_FILE = fileURLToPath(new URL('../opencode-go-keys.txt', import.meta.url));

const TOOLS = [
  {
    name: 'quota_check',
    description:
      '查询 opencode Go 订阅套餐的用量配额：5 小时 / 周 / 月三个窗口的已用百分比、剩余额度与重置时间；'
      + '支持多 key 名册（一人一把独立订阅 key）逐人查询并汇总，key 一律掩码。',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['table', 'json'],
          description: '输出格式：table=人读表格（默认）；json=结构化结果（含 summary 与逐 key 明细）',
        },
        console: {
          type: 'boolean',
          description: '附带 console 订阅状态：套餐期、支付方式、按微美分的精确用量（1e8 = US$1）',
        },
      },
      additionalProperties: false,
    },
  },
];

const INSTRUCTIONS = [
  '### opencode Go Quota MCP (opencode)',
  '一个工具：quota_check — 查询 opencode Go 订阅的用量配额（5 小时 / 周 / 月窗口），',
  '可选 console=true 附带订阅状态（套餐期、支付方式、微美分精确用量）。',
  '多 key 名册（一人一把独立订阅 key）由服务端配置：逐人串行查询，单把 key 失败不影响其他人，',
  '结果按人一行汇总（失败行标注错误）。format="json" 时返回结构化 summary + 逐 key 明细。',
  '什么时候用：用户问 opencode 用量 / 配额 / 剩多少 / 谁用得多 / 会不会撞限，或做周期盘点。',
  '查询走 opencode.ai 官网接口，偶发瞬时网络失败：整次失败（isError）就重试一次，最多两次，别反复刷。',
  '结果里的 API key 全部掩码；不要试图还原、拼接或向用户索要完整 key。',
  '新增成员 / 换 key：让用户直接编辑服务端名册文件，不从对话里收 key。',
].join('\n');

/**
 * 跑一次 quota CLI 并收齐输出。
 * @param {{json?:boolean, withConsole?:boolean, keysFile?:string|null, cliPath?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 *   exit 0 / 2 → resolve（2 = 部分 key 失败，结果仍完整）；其余 → reject。
 */
export function runQuota(opts = {}) {
  const json = opts.json === true;
  const withConsole = opts.withConsole === true;
  const keysFile = opts.keysFile ?? null;
  const cliPath = opts.cliPath ?? CLI_PATH;
  const timeoutMs = opts.timeoutMs ?? 55000;

  return new Promise((resolve, reject) => {
    const args = [cliPath];
    if (json) args.push('--json');
    if (withConsole) args.push('--console');
    if (keysFile) args.push('--keys-file', keysFile);

    let child;
    try {
      child = spawn(process.execPath, args, { cwd: path.dirname(cliPath), windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn(val);
    };
    const onTimeout = () => {
      try { child.kill(); } catch { /* 已退出则忽略 */ }
      finish(reject, new Error(`quota 查询超时（${timeoutMs}ms），已终止 CLI 子进程`));
    };

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code === 0 || code === 2) {
        finish(resolve, { code, stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        const detail = (stderr.trim() || stdout.trim() || '(no output)').slice(0, 400);
        finish(reject, new Error(`quota CLI exit ${code}: ${detail}`));
      }
    });

    timer = setTimeout(onTimeout, timeoutMs);
  });
}

/**
 * 启动 stdio MCP 服务。
 * @param {{inStream?:any,outStream?:any}} [io] - 流（默认 stdin/stdout；测试可注入）
 * @param {{keysFile?:string|null, cliPath?:string}} [opts] - keysFile：每次调用透传给 CLI 的名册；null = CLI 自行发现
 * @returns {{close:()=>void}} 句柄
 */
export function startMcpServer(io = {}, opts = {}) {
  const outStream = io.outStream ?? process.stdout;
  const keysFile = opts.keysFile === undefined ? DEFAULT_KEYS_FILE : opts.keysFile;

  const rl = createInterface({ input: io.inStream ?? process.stdin, output: null, terminal: false });

  const send = (obj) => outStream.write(`${JSON.stringify(obj)}\n`);
  const result = (id, r) => send({ jsonrpc: '2.0', id, result: r });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const HANDLERS = {
    quota_check: async (a) => {
      const json = a?.format === 'json';
      const out = await runQuota({
        json,
        withConsole: a?.console === true,
        keysFile,
        cliPath: opts.cliPath,
      });
      if (json) {
        let parsed;
        try {
          parsed = JSON.parse(out.stdout);
        } catch {
          throw new Error(`CLI --json 输出不可解析（exit ${out.code}）：${out.stdout.slice(0, 200)}`);
        }
        return JSON.stringify(parsed, null, 2);
      }
      return out.stdout || '(CLI 无输出)';
    },
  };

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      error(null, -32700, 'Parse error');
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined || id === null) return; // 通知不需要回应

    try {
      switch (method) {
        case 'initialize':
          result(id, {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'opencode-quota-mcp', version: SERVER_VERSION },
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS,
          });
          break;
        case 'tools/list':
          result(id, { tools: TOOLS });
          break;
        case 'tools/call': {
          const fn = HANDLERS[params?.name];
          if (!fn) { error(id, -32601, `Tool not found: ${params?.name}`); return; }
          try {
            const out = await fn(params?.arguments ?? {});
            result(id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
          } catch (err) {
            // 工具内部失败走 isError，不要掀翻整条连接
            result(id, {
              isError: true,
              content: [{ type: 'text', text: `${params.name} 失败: ${err instanceof Error ? err.message : String(err)}` }],
            });
          }
          break;
        }
        case 'ping':
          result(id, {});
          break;
        default:
          error(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      error(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { close: () => rl.close() };
}

/** 诊断摘要（只含路径与存在性，绝不包含名册内容——名册里有真 key）。 */
export function describeSetup(keysFile) {
  const tools = TOOLS.map((t) => t.name).join(', ');
  if (keysFile == null) {
    return `server: ${SERVER_NAME} (namespace)  tools: ${tools}  roster: (未指定，由 CLI 自动发现)`;
  }
  let exists = '?';
  try { exists = String(fs.existsSync(keysFile)); } catch { exists = '?'; }
  return `server: ${SERVER_NAME} (namespace)  tools: ${tools}  roster: ${keysFile} (exists=${exists})`;
}

export { SERVER_NAME };
