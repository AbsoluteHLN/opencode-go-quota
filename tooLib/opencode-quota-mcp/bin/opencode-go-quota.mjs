#!/usr/bin/env node
/**
 * opencode-go-quota.mjs — opencode Go 订阅额度检测（零依赖单文件，Node >= 18）
 *
 * v1.1.0 多 key（多人）模式:
 *   - 口径: 一人一把独立订阅的 Go API key；工具逐把顺序查询官方接口，按人一行输出
 *   - --key 可重复（支持 标签|key）；--keys-file <PATH> 可重复（名册，每行一人）
 *   - 自动发现脚本同目录 opencode-go-keys.txt（存在且含有效 key 才启用）
 *   - 按 key 值去重（保留首个标签）；去重后仅剩 1 把 → 与 v1.0.0 完全一致的单 key 行为
 *   - ≥2 把 → 逐把顺序查询（无并发无延时），单把失败不中断其余；任一失败退出码 2
 *   - 说明: 官方 usage 接口只返回订阅级三窗口聚合（rolling/weekly/monthly 的 percent+resetsAt），
 *     无按人/按 key/按模型字段；多 key 循环是「一人一把独立订阅 key」的本地归因方式
 *
 * v1.2.0 口径说明（人类可读输出尾部新增双口径说明；--json 结构与查询行为不变）:
 *   - 本工具输出的是「账户级聚合」口径（usage 三窗口 + console 账户级 meters）
 *   - 官方控制台另有「按模型限额」口径（每模型独立月度美元限额），两套并存互不覆盖
 *   - 详见 https://opencode.ai/docs/console/go/
 *
 * 数据源（官方正式接口，2026-08 上线）:
 *   GET https://opencode.ai/zen/go/v1/usage    Authorization: Bearer <Go API key>
 *   响应: { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 *   备用端点: GET https://opencode.ai/inference/go/v1/usage（主端点 404/405 时自动回退）
 *   status 为 "rate-limited" 即该窗口用满（未开 Use balance 时请求会被拦）。
 *
 * 可选 --console 查询控制台内部接口（非公开文档，字段可能变动，解析失败不影响主结果）:
 *   GET https://opencode.ai/console/api/go/status
 *   access.meters.{fiveHour,week,month}.{usedMicroCents,limitMicroCents}（1e8 microCents = US$1）
 *   access.{startsAt,endsAt} / cancelAtPeriodEnd / renewalPending / paymentMethodKind / useBalance / upgradePrice
 *   多 key 模式下 --console 结果仅写入对应人的 results[].console，不渲染到人类表格。
 *
 * 名册文件格式（--keys-file / 自动发现 opencode-go-keys.txt）:
 *   - 每行一人: 标签|API key，或仅 API key（标签建议真实姓名/代号）
 *   - "|" 为唯一分隔符（API key 不含 |）；整行 # 开头为注释；空行忽略
 *   - 行内注释: 该行内容之后以 " #" 起始的尾部会被截断
 *   - key 不允许含空白字符；自动剥 BOM 与成对引号
 *
 * key 解析优先级（从高到低，全程不打印值，输出中 key 一律以掩码显示）:
 *   1. --key（可重复） / --key-file（单 key 文件） / --keys-file（多人名册，可重复）
 *   2. 自动发现: 脚本同目录 opencode-go-keys.txt（存在且含有效 key 才启用；0 个有效 key 时备注并继续向下）
 *   3. 环境变量 OPENCODE_GO_API_KEY
 *   4. 环境变量 OPENCODE_AUTH_CONTENT（auth.json 全文 JSON）
 *   5. <auth.json> 的 "opencode-go" 条目（XDG_DATA_HOME 可覆盖根目录；
 *      默认 %USERPROFILE%\.local\share\opencode\auth.json）
 *   6. %USERPROFILE%\.dsh\.credentials.yaml 的 OPENCODE_GO_API_KEY 条目
 *   7. %USERPROFILE%\.minimax\config.yaml 的 opencode-go -> options.apiKey（本机 BYOK 供应商配置兜底）
 *
 * 退出码: 0 全部成功（含 rate-limited，看 JSON 的 anyRateLimited）
 *         1 无 key / 参数错误
 *         2 任一 key 查询失败（多 key 模式部分失败也算 2；单 key 模式网络/HTTP/解析错误）
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const VERSION = '1.2.0';
const USAGE_PRIMARY = process.env.OPENCODE_GO_USAGE_URL || 'https://opencode.ai/zen/go/v1/usage';
const USAGE_FALLBACK = 'https://opencode.ai/inference/go/v1/usage';
const CONSOLE_STATUS = 'https://opencode.ai/console/api/go/status';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROSTER_BASENAME = 'opencode-go-keys.txt';

let JSON_MODE = false;

function die(code, msg) {
  const line = '[opencode-go-quota] ' + msg;
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ ok: false, tool: 'opencode-go-quota', version: VERSION, error: msg }, null, 2) + '\n');
  } else {
    process.stderr.write(line + '\n');
  }
  process.exit(code);
}

class QuotaError extends Error {
  constructor(msg) { super(msg); this.name = 'QuotaError'; }
}

function parseArgs(argv) {
  const o = { json: false, console: false, keys: [], keyFiles: [], keysFiles: [], timeout: 15000, fallback: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--console') o.console = true;
    else if (a === '--key') { const v = argv[++i]; if (!v) die(1, '--key 需要一个值'); o.keys.push(v); }
    else if (a === '--key-file') { const v = argv[++i]; if (!v) die(1, '--key-file 需要一个路径'); o.keyFiles.push(v); }
    else if (a === '--keys-file') { const v = argv[++i]; if (!v) die(1, '--keys-file 需要一个路径'); o.keysFiles.push(v); }
    else if (a === '--timeout') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) die(1, '--timeout 需要正整数毫秒');
      o.timeout = v;
    }
    else if (a === '--no-fallback') o.fallback = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else die(1, '未知参数: ' + a + '（--help 查看用法）');
  }
  return o;
}

function usage() {
  process.stdout.write(
    'opencode Go 额度检测 v' + VERSION + '（零依赖，Node >= 18）\n' +
    '\n' +
    '用法:\n' +
    '  node opencode-go-quota.mjs [选项]\n' +
    '  多人模式: 每人一把独立订阅的 Go API key，逐把查询官方接口，按人一行输出\n' +
    '\n' +
    '选项:\n' +
    '  --json             机器可读 JSON 输出（供其他 agent / 脚本消费）\n' +
    '  --console          额外查询控制台接口（套餐期/总额度池/支付方式；非公开接口，解析失败不影响主结果）\n' +
    '  --key <KEY>        显式指定 API key，可重复；支持 标签|key 写法（如 张三|oc_xxx）\n' +
    '  --key-file <PATH>  从文件读单把 key：单行纯文本，或 opencode auth.json 格式\n' +
    '  --keys-file <PATH> 多人名册文件，可重复；每行一人: 标签|key 或纯 key\n' +
    '  --timeout <MS>     单请求超时毫秒（默认 15000）\n' +
    '  --no-fallback      不尝试备用端点\n' +
    '  -h, --help         显示本帮助\n' +
    '\n' +
    '名册文件格式（--keys-file / 自动发现 opencode-go-keys.txt）:\n' +
    '  每行一人: 标签|API key 或纯 API key；"|" 为唯一分隔符（API key 不含 |）\n' +
    '  整行 # 开头为注释，空行忽略；行内注释: " #" 之后的尾部被截断\n' +
    '  key 不得含空白字符；自动剥 BOM 与成对引号\n' +
    '\n' +
    'key 解析顺序（优先级从高到低，全程不打印值）:\n' +
    '  1. --key / --key-file / --keys-file（显式传参，优先于自动发现）\n' +
    '  2. 自动发现: 脚本同目录 opencode-go-keys.txt（存在且含有效 key 才启用；\n' +
    '     0 个有效 key 时备注并继续向下）\n' +
    '  3. 环境变量 OPENCODE_GO_API_KEY\n' +
    '  4. 环境变量 OPENCODE_AUTH_CONTENT（auth.json 全文）\n' +
    '  5. auth.json 的 "opencode-go" 条目（XDG_DATA_HOME 可覆盖根目录；\n' +
    '     默认 %USERPROFILE%\\.local\\share\\opencode\\auth.json）\n' +
    '  6. %USERPROFILE%\\.dsh\\.credentials.yaml 的 OPENCODE_GO_API_KEY 条目\n' +
    '  7. %USERPROFILE%\\.minimax\\config.yaml 的 opencode-go -> options.apiKey（本机兜底）\n' +
    '\n' +
    '多 key 规则:\n' +
    '  - 按 key 值去重（保留首个标签，重复条目出备注）\n' +
    '  - 去重后仅剩 1 把 → 单 key 模式，输出/退出码与 v1.0.0 完全一致\n' +
    '  - ≥2 把 → 逐把顺序查询，单把失败不中断其余\n' +
    '  - key 一律以掩码显示（≤12 位全打码，否则前 4 位…后 4 位）\n' +
    '\n' +
    '退出码: 0 全部成功（含窗口 rate-limited，见 --json 的 anyRateLimited）\n' +
    '        1 无 key / 参数错误\n' +
    '        2 任一 key 查询失败（多 key 部分失败也算 2）\n' +
    '\n' +
    '口径说明（两部分数字，别混看）:\n' +
    '  ① 条形/百分比 = usage 接口按订阅返回的三窗口已用百分比，是这把 key\n' +
    '  自己的用量；官方接口无按人/按 key/按模型字段，多 key 循环是「一人一把\n' +
    '  独立订阅 key」的本地归因。\n' +
    '  ② --console 金额 = console 接口的账户级 meters，是整个账户共享的\n' +
    '  总额度池，不是某一把 key 的个人消费（多 key 时为各 key 所在账户各自的池子）。\n' +
    '  另: 官方控制台还有「按模型限额」口径: 每个模型有独立月度美元限额，\n' +
    '  5h/周/月窗口分别为月限的 20%/50%/100%（例: DeepSeek V4.1 Flash，\n' +
    '  Go 档月限 $100）。限额可能调整，以官方文档为准:\n' +
    '  https://opencode.ai/docs/console/go/\n'
  );
}

const stripQ = (s) => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
};

const maskKey = (k) => (k.length <= 12) ? '*'.repeat(k.length) : k.slice(0, 4) + '…' + k.slice(-4);

// CJK 显示宽度（全角按 2 列计），用于多 key 表格对齐
const dlen = (s) => { let w = 0; for (const ch of String(s)) w += ch.codePointAt(0) > 0xFF ? 2 : 1; return w; };
const padD = (s, n) => { s = String(s); const d = dlen(s); return d >= n ? s : s + ' '.repeat(n - d); };

// 解析多人名册文本 → [{key,label,source}]；格式错误 die(1)（带 文件:行号）
function parseRosterText(text, src) {
  const entries = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let t = lines[i].trim();
    const no = i + 1;
    if (!t || t.startsWith('#')) continue;
    const ci = t.indexOf(' #');
    if (ci >= 0) t = t.slice(0, ci).trim();
    if (!t) continue;
    const parts = t.split('|');
    if (parts.length > 2) die(1, src + ' 第 ' + no + ' 行格式错误: 最多一个 "|" 分隔符（标签|key）');
    let label = null;
    let key;
    if (parts.length === 2) {
      label = stripQ(parts[0]) || null;
      key = stripQ(parts[1]);
    } else {
      key = stripQ(parts[0]);
    }
    if (!key) die(1, src + ' 第 ' + no + ' 行: key 为空');
    if (/\s/.test(key)) die(1, src + ' 第 ' + no + ' 行: key 含空白字符（key 应为单行连续文本，标签与 key 用 "|" 分隔）');
    entries.push({ key, label, source: src + '#' + no });
  }
  return entries;
}

function findApiKeyInAuthObj(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const e = obj['opencode-go'];
  if (e == null) return null;
  if (typeof e === 'string') return e.trim() || null;
  if (typeof e === 'object') {
    const k = e.key ?? e.apiKey ?? e.api_key;
    return (typeof k === 'string' && k.trim()) ? k.trim() : null;
  }
  return null;
}

function authFilePaths() {
  const list = [];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) list.push(path.join(xdg, 'opencode', 'auth.json'));
  list.push(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'));
  return list;
}

function keyFromAuthFile(notes) {
  for (const f of authFilePaths()) {
    if (!existsSync(f)) continue;
    try {
      const obj = JSON.parse(readFileSync(f, 'utf8'));
      const k = findApiKeyInAuthObj(obj);
      if (k) return { key: k, source: 'auth-file:' + f };
      notes.push('auth.json 存在但无 opencode-go 条目: ' + f + '（现有条目: ' + Object.keys(obj).join(',') + '）');
    } catch (e) {
      notes.push('auth.json 读取/解析失败: ' + f + '（' + e.message + '）');
    }
  }
  return null;
}

function keyFromEnvAuthContent(notes) {
  const c = process.env.OPENCODE_AUTH_CONTENT;
  if (!c) return null;
  try {
    const k = findApiKeyInAuthObj(JSON.parse(c));
    if (k) return { key: k, source: 'env:OPENCODE_AUTH_CONTENT' };
    notes.push('OPENCODE_AUTH_CONTENT 中无 opencode-go 条目');
  } catch {
    notes.push('OPENCODE_AUTH_CONTENT 不是合法 JSON');
  }
  return null;
}

function keyFromDsh(notes) {
  const f = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(f)) return null;
  try {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*OPENCODE_GO_API_KEY\s*:\s*(.+?)\s*$/);
      if (m) {
        const v = stripQ(m[1]);
        if (v) return { key: v, source: 'dsh-credentials:' + f };
      }
    }
  } catch (e) {
    notes.push('DSH 凭证读取失败: ' + e.message);
  }
  return null;
}

function keyFromMiniMaxConfig(notes) {
  const f = path.join(os.homedir(), '.minimax', 'config.yaml');
  if (!existsSync(f)) return null;
  let lines;
  try {
    lines = readFileSync(f, 'utf8').split(/\r?\n/);
  } catch (e) {
    notes.push('minimax 配置读取失败: ' + e.message);
    return null;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)opencode-go:\s*$/);
    if (!m) continue;
    const base = m[1].length;
    let enabled = null;
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (ln.trim() === '') continue;
      const ind = ln.length - ln.trimStart().length;
      if (ind <= base) break; // 离开 opencode-go 条目块
      const ke = ln.match(/^\s*enabled\s*:\s*(.+?)\s*$/);
      if (ke) enabled = stripQ(ke[1]).toLowerCase();
      const k = ln.match(/^\s*apiKey\s*:\s*(.+?)\s*$/);
      if (k) {
        const v = stripQ(k[1]);
        if (v) {
          if (enabled === 'false') notes.push('minimax 配置中 opencode-go enabled=false（供应商已停用，key 可能过期）');
          return { key: v, source: 'minimax-config:' + f };
        }
      }
    }
  }
  return null;
}

// 默认 7 级链的兜底段（显式传参与名册未命中时使用）
function resolveKey(notes) {
  if (process.env.OPENCODE_GO_API_KEY && process.env.OPENCODE_GO_API_KEY.trim()) {
    return { key: process.env.OPENCODE_GO_API_KEY.trim(), source: 'env:OPENCODE_GO_API_KEY' };
  }
  return keyFromEnvAuthContent(notes) || keyFromAuthFile(notes) || keyFromDsh(notes) || keyFromMiniMaxConfig(notes);
}

// 收集全部 key 条目（显式传参 → 自动发现名册 → 兜底链），不打印 key 值
function collectKeys(opts, notes) {
  const entries = [];
  const explicit = opts.keys.length > 0 || opts.keyFiles.length > 0 || opts.keysFiles.length > 0;
  for (let i = 0; i < opts.keys.length; i++) {
    const raw = opts.keys[i].trim();
    let label = null;
    let key = raw;
    const sep = raw.indexOf('|');
    if (sep >= 0) {
      label = raw.slice(0, sep).trim() || null;
      key = raw.slice(sep + 1).trim();
    }
    if (!key) die(1, '--key 值缺少 key 部分（格式: key 或 标签|key）');
    if (/\s/.test(key)) die(1, '--key 值含空白字符');
    entries.push({ key, label, source: opts.keys.length > 1 ? 'arg:--key#' + (i + 1) : 'arg:--key' });
  }
  for (let i = 0; i < opts.keyFiles.length; i++) {
    const p = opts.keyFiles[i];
    let raw;
    try {
      raw = readFileSync(opts.keyFiles[i], 'utf8').trim();
    } catch (e) {
      die(1, '--key-file 读取失败: ' + e.message);
    }
    const srcPfx = opts.keyFiles.length > 1 ? 'key-file#' + (i + 1) + ':' : 'key-file:';
    const srcJsonPfx = opts.keyFiles.length > 1 ? 'key-file(json)#' + (i + 1) + ':' : 'key-file(json):';
    if (raw.startsWith('{')) {
      let k = null;
      try {
        k = findApiKeyInAuthObj(JSON.parse(raw));
      } catch (e) {
        die(1, '--key-file 的 JSON 解析失败: ' + e.message);
      }
      if (!k) die(1, '--key-file 的 JSON 中没有 opencode-go 条目: ' + p);
      entries.push({ key: k, label: null, source: srcJsonPfx + p });
    } else {
      if (!raw || /\s/.test(raw)) die(1, '--key-file 内容既不是单行 key 也不是 auth.json 格式: ' + p);
      entries.push({ key: raw, label: null, source: srcPfx + p });
    }
  }
  for (const p of opts.keysFiles) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch (e) {
      die(1, '--keys-file 读取失败: ' + e.message);
    }
    const got = parseRosterText(text, 'keys-file:' + p);
    if (!got.length) notes.push('--keys-file 无有效 key 行: ' + p + '（继续按更低优先级解析）');
    entries.push(...got);
  }
  if (!explicit) {
    const roster = path.join(SCRIPT_DIR, ROSTER_BASENAME);
    if (existsSync(roster)) {
      let text = null;
      try {
        text = readFileSync(roster, 'utf8');
      } catch (e) {
        notes.push('自动发现名册读取失败: ' + roster + '（' + e.message + '）');
      }
      if (text != null) {
        const got = parseRosterText(text, 'roster:' + roster);
        if (got.length) {
          notes.push('自动发现名册: ' + roster + '（' + got.length + ' 个 key 条目）');
          entries.push(...got);
        } else {
          notes.push('自动发现名册无有效 key 行: ' + roster + '（回退默认 key 解析链）');
        }
      }
    }
  }
  if (!entries.length) {
    const chain = resolveKey(notes);
    if (chain) entries.push({ key: chain.key, label: null, source: chain.source });
  }
  return entries;
}

async function get(url, key, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        'User-Agent': 'opencode-go-quota/' + VERSION,
      },
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUsage(key, opts, notes) {
  const attempts = [{ url: USAGE_PRIMARY, label: 'primary' }];
  if (opts.fallback && USAGE_FALLBACK && USAGE_FALLBACK !== USAGE_PRIMARY) attempts.push({ url: USAGE_FALLBACK, label: 'fallback' });
  let lastLabel = attempts[0].label;
  for (const a of attempts) {
    lastLabel = a.label;
    let r;
    try {
      r = await get(a.url, key, opts.timeout);
    } catch (e) {
      const why = e && e.name === 'AbortError' ? '超时（' + opts.timeout + 'ms）' : (e && e.message) || String(e);
      throw new QuotaError('请求失败（' + a.label + '）: ' + why);
    }
    if (r.status === 404 || r.status === 405) {
      notes.push(a.label + ' 端点返回 ' + r.status + '，尝试备用端点');
      continue;
    }
    if (r.status === 401) throw new QuotaError('HTTP 401: key 无效或未授权（确认这是 opencode Go 订阅的 API key）');
    if (r.status === 403) throw new QuotaError('HTTP 403: 被拒绝（该 key 可能没有 Go 套餐权限）');
    if (r.status === 429) throw new QuotaError('HTTP 429: 请求被限流，请稍后再试');
    if (r.status !== 200) throw new QuotaError('HTTP ' + r.status + ': 意外状态码（' + a.label + '）');
    try {
      return { url: a.url, data: JSON.parse(r.text) };
    } catch {
      throw new QuotaError('响应不是合法 JSON（' + a.label + '）');
    }
  }
  throw new QuotaError('所有端点均不可用（最后尝试: ' + lastLabel + '）');
}

function extractWindows(data) {
  const u = (data && typeof data === 'object' && data.usage && typeof data.usage === 'object') ? data.usage : data;
  const out = {};
  for (const n of ['rolling', 'weekly', 'monthly']) {
    const w = (u && typeof u === 'object') ? u[n] : null;
    if (!w || typeof w !== 'object') { out[n] = null; continue; }
    const ts = w.resetsAt != null ? Date.parse(w.resetsAt) : NaN;
    out[n] = {
      status: (typeof w.status === 'string') ? w.status : null,
      percent: (typeof w.percent === 'number') ? w.percent : null,
      resetsAt: (typeof w.resetsAt === 'string') ? w.resetsAt : null,
      resetAtMs: Number.isFinite(ts) ? ts : null,
    };
  }
  return out;
}

function extractConsole(data) {
  if (!data || typeof data !== 'object') return null;
  const a = (data.access && typeof data.access === 'object') ? data.access : data;
  const meters = (a.meters && typeof a.meters === 'object') ? a.meters : null;
  const toNum = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : ((typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) ? Number(v) : null);
  const dollar = (v) => { const n = toNum(v); return (n == null) ? null : Math.round(n) / 1e8; }; // microCents（实测为字符串）-> US$
  const meter = (k) => {
    const m = meters ? meters[k] : null;
    if (!m || typeof m !== 'object') return null;
    return { used: dollar(m.usedMicroCents), limit: dollar(m.limitMicroCents) };
  };
  const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v))) ? v : null;
  const bool = (v) => (typeof v === 'boolean') ? v : null;
  const str = (v) => (typeof v === 'string' && v) ? v : null;
  return {
    periodStart: iso(a.startsAt),
    periodEnd: iso(a.endsAt),
    cancelAtPeriodEnd: bool(data.cancelAtPeriodEnd) ?? bool(a.cancelAtPeriodEnd),
    renewalPending: bool(data.renewalPending) ?? bool(a.renewalPending),
    paymentMethodKind: str(data.paymentMethodKind) ?? str(a.paymentMethodKind),
    useBalance: bool(data.useBalance) ?? bool(a.useBalance),
    renewalAuthorizationRequired: bool(data.renewalAuthorizationRequired) ?? bool(a.renewalAuthorizationRequired),
    upgradePrice: (toNum(data.upgradePrice) != null) ? data.upgradePrice : ((toNum(a.upgradePrice) != null) ? a.upgradePrice : null),
    meters: meters
      ? { fiveHour: meter('fiveHour'), week: meter('week'), month: meter('month') }
      : null,
  };
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const bar = (p, width = 14) => {
  if (p == null) return '[' + '.'.repeat(width) + ']';
  const f = Math.max(0, Math.min(width, Math.round((p / 100) * width)));
  return '[' + '#'.repeat(f) + '.'.repeat(width - f) + ']';
};

function humanDelta(ms) {
  if (ms == null) return '';
  if (ms <= 0) return '（已到重置点）';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d >= 1) return '（' + d + '天' + h + '小时后）';
  if (h >= 1) return '（' + h + '小时' + m + '分后）';
  if (m >= 1) return '（' + m + '分钟后）';
  return '（<1分钟后）';
}

function fmtReset(w) {
  if (w == null) return '未知';
  if (w.resetAtMs == null) return w.resetsAt || '未知';
  const d = new Date(w.resetAtMs);
  const p2 = (x) => String(x).padStart(2, '0');
  return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' UTC';
}

function renderCaliberNote() {
  process.stdout.write(
    '\n口径说明（两部分数字，别混看）:\n' +
    '  ① 条形/百分比 = usage 接口按订阅返回的三窗口已用百分比，是这把 key\n' +
    '  自己的用量；官方接口无按人/按 key/按模型字段，多 key 循环是「一人一把\n' +
    '  独立订阅 key」的本地归因。\n' +
    '  ② --console 金额 = console 接口的账户级 meters，是整个账户共享的\n' +
    '  总额度池，不是某一把 key 的个人消费（多 key 时为各 key 所在账户各自的池子）。\n' +
    '  另: 官方控制台还有「按模型限额」口径: 每个模型有独立月度美元限额，\n' +
    '  5h/周/月窗口分别为月限的 20%/50%/100%（例: DeepSeek V4.1 Flash，\n' +
    '  Go 档月限 $100）。限额可能调整，以官方文档为准:\n' +
    '  https://opencode.ai/docs/console/go/\n'
  );
}

function renderHuman(win, consoleInfo, notes, endpoint) {
  process.stdout.write('opencode Go 额度检测 v' + VERSION + '\n');
  process.stdout.write('数据源: ' + endpoint + '\n\n');
  process.stdout.write('  窗口          已用                状态            重置\n');
  const rows = [['5h rolling', 'rolling'], ['weekly', 'weekly'], ['monthly', 'monthly']];
  for (const [label, key] of rows) {
    const w = win[key];
    if (w == null) {
      process.stdout.write('  ' + pad(label, 12) + '  响应缺少该窗口数据\n');
      continue;
    }
    process.stdout.write(
      '  ' + pad(label, 12) + ' ' + bar(w.percent) + ' ' + padL((w.percent == null ? '?' : w.percent) + '%', 4) +
      '   ' + pad(w.status || '?', 13) + ' ' + fmtReset(w) + ' ' + (w.resetAtMs != null ? humanDelta(w.resetAtMs - Date.now()) : '') + '\n'
    );
  }
  for (const [label, key] of rows) {
    const w = win[key];
    if (w && w.status && w.status !== 'ok') {
      process.stdout.write('  ! ' + label + ' 状态 = ' + w.status + (w.status === 'rate-limited' ? '（该窗口用满，未开 Use balance 时请求会被拦）' : '') + '\n');
    }
  }
  if (consoleInfo) {
    const c = consoleInfo;
    process.stdout.write('\n订阅与总额度池（console 内部接口；金额=账户级 meters，整个账户共享，不代表单把 key 的消费）:\n');
    if (c.periodStart || c.periodEnd) {
      process.stdout.write('  套餐期: ' + ((c.periodStart || '?').slice(0, 10)) + ' -> ' + ((c.periodEnd || '?').slice(0, 10)) +
        (c.cancelAtPeriodEnd != null ? '  cancelAtPeriodEnd=' + c.cancelAtPeriodEnd : '') + '\n');
    }
    if (c.meters) {
      const f = (m) => (m ? ((m.used == null ? '?' : '$' + m.used.toFixed(2)) + ' / ' + (m.limit == null ? '?' : '$' + m.limit.toFixed(2))) : '?');
      process.stdout.write('  5h: ' + f(c.meters.fiveHour) + '    周: ' + f(c.meters.week) + '    月: ' + f(c.meters.month) + '\n');
    }
    const extra = [];
    if (c.paymentMethodKind) extra.push('支付: ' + c.paymentMethodKind);
    if (c.useBalance != null) extra.push('useBalance=' + c.useBalance);
    if (c.renewalPending != null) extra.push('renewalPending=' + c.renewalPending);
    if (c.renewalAuthorizationRequired != null) extra.push('renewalAuthRequired=' + c.renewalAuthorizationRequired);
    if (c.upgradePrice != null) extra.push('upgradePrice=' + c.upgradePrice);
    if (extra.length) process.stdout.write('  ' + extra.join('    ') + '\n');
  }
  if (notes.length) {
    process.stdout.write('\n备注:\n');
    for (const n of notes) process.stdout.write('  - ' + n + '\n');
  }
  renderCaliberNote();
}

const WIN_SHORT = { rolling: '5h', weekly: '周', monthly: '月' };
const winCell = (w) => (w == null) ? '-' : (w.percent == null ? '?' : (w.percent + '%'));

function renderMulti(results, notes) {
  process.stdout.write('opencode Go 额度检测 v' + VERSION + '（多 key 模式，共 ' + results.length + ' 人）\n\n');
  process.stdout.write('  ' + padD('人员', 10) + '  ' + padD('key', 12) + '  ' + padL('5h', 4) + '  ' + padL('周', 4) + '  ' + padL('月', 4) + '  状态\n');
  for (const r of results) {
    let c5 = '-';
    let cw = '-';
    let cm = '-';
    let status = '失败';
    if (r.ok && r.windows) {
      c5 = winCell(r.windows.rolling);
      cw = winCell(r.windows.weekly);
      cm = winCell(r.windows.monthly);
      const badges = [];
      for (const wk of ['rolling', 'weekly', 'monthly']) {
        const w = r.windows[wk];
        if (w && w.status && w.status !== 'ok') {
          badges.push((w.status === 'rate-limited' ? '限流:' : (w.status + ':')) + WIN_SHORT[wk]);
        }
      }
      status = badges.length ? badges.join(',') : '正常';
    }
    process.stdout.write('  ' + padD(r.label, 10) + '  ' + padD(r.keyMask, 12) + '  ' + padL(c5, 4) + '  ' + padL(cw, 4) + '  ' + padL(cm, 4) + '  ' + status + '\n');
    if (!r.ok && r.error) process.stdout.write('        └ ' + r.error + '\n');
  }
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write('\n汇总: 共 ' + results.length + ' 人，成功 ' + (results.length - failed) + '，失败 ' + failed +
    (failed > 0 ? '（存在失败，退出码 2）' : '') + '\n');
  const withMeters = results.filter((r) => r.ok && r.console && r.console.meters);
  if (withMeters.length) {
    process.stdout.write('\n总额度池（console meters，账户级聚合，每人各自的账户池子）:\n');
    const f = (m) => (m ? ((m.used == null ? '?' : '$' + m.used.toFixed(2)) + ' / ' + (m.limit == null ? '?' : '$' + m.limit.toFixed(2))) : '?');
    for (const r of withMeters) {
      const m = r.console.meters;
      process.stdout.write('  ' + padD(r.label, 10) + '  5h: ' + f(m.fiveHour) + '    周: ' + f(m.week) + '    月: ' + f(m.month) + '\n');
    }
  }
  const perNotes = [];
  for (const r of results) {
    for (const n of r.notes || []) perNotes.push('[' + r.label + '] ' + n);
  }
  if (notes.length || perNotes.length) {
    process.stdout.write('\n备注:\n');
    for (const n of notes) process.stdout.write('  - ' + n + '\n');
    for (const n of perNotes) process.stdout.write('  - ' + n + '\n');
  }
  renderCaliberNote();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); process.exit(0); }
  JSON_MODE = opts.json;

  const notes = [];
  const all = collectKeys(opts, notes);
  if (!all.length) {
    die(1, '未找到 opencode Go API key。可任选其一: --key / --key-file / --keys-file / 脚本同目录 opencode-go-keys.txt 名册 / ' +
      'OPENCODE_GO_API_KEY 环境变量 / auth.json 的 opencode-go 条目 / ~/.dsh/.credentials.yaml / ~/.minimax/config.yaml 的 opencode-go 配置');
  }

  const seen = new Map();
  const dups = [];
  for (const e of all) {
    if (seen.has(e.key)) dups.push(e);
    else seen.set(e.key, e);
  }
  for (const d of dups) {
    const first = seen.get(d.key);
    notes.push('去重: 忽略重复 key 条目 ' + (d.label || maskKey(d.key)) + '（' + d.source + '），与 ' +
      (first.label || maskKey(first.key)) + '（' + first.source + '）相同');
  }
  const keys = [...seen.values()];

  const j = (w) => w ? {
    status: w.status,
    percent: w.percent,
    resetsAt: w.resetsAt,
    resetInSec: (w.resetAtMs != null) ? Math.round((w.resetAtMs - Date.now()) / 1000) : null,
    rateLimited: w.status === 'rate-limited',
  } : null;

  if (keys.length === 1) {
    const found = keys[0];
    let usageRes;
    try {
      usageRes = await fetchUsage(found.key, opts, notes);
    } catch (e) {
      die(2, (e && e.message) || String(e));
    }
    const win = extractWindows(usageRes.data);

    let consoleInfo = null;
    if (opts.console) {
      try {
        const r = await get(CONSOLE_STATUS, found.key, opts.timeout);
        if (r.status === 200) {
          try { consoleInfo = extractConsole(JSON.parse(r.text)); }
          catch { notes.push('console 接口返回非 JSON，跳过'); }
        } else {
          notes.push('console 接口 HTTP ' + r.status + '，跳过订阅/金额信息（该接口非公开文档，可能变化）');
        }
      } catch (e) {
        notes.push('console 接口请求失败: ' + ((e && e.message) || String(e)));
      }
    }

    const anyRateLimited = Object.values(win).some((w) => w && w.status === 'rate-limited');
    const result = {
      label: found.label || maskKey(found.key),
      keyMask: maskKey(found.key),
      keySource: found.source,
      ok: true,
      endpoint: usageRes.url,
      windows: { rolling: j(win.rolling), weekly: j(win.weekly), monthly: j(win.monthly) },
      anyRateLimited,
      notes,
    };
    if (opts.console) result.console = consoleInfo;

    if (JSON_MODE) {
      process.stdout.write(JSON.stringify({
        ok: true,
        tool: 'opencode-go-quota',
        version: VERSION,
        checkedAt: new Date().toISOString(),
        keySource: found.source,
        endpoint: usageRes.url,
        windows: { rolling: j(win.rolling), weekly: j(win.weekly), monthly: j(win.monthly) },
        anyRateLimited,
        console: consoleInfo,
        notes,
        mode: 'single',
        summary: { total: 1, ok: 1, failed: 0 },
        results: [result],
      }, null, 2) + '\n');
    } else {
      renderHuman(win, consoleInfo, notes, usageRes.url);
    }
    process.exit(0);
  }

  const results = [];
  for (const e of keys) {
    const r = { label: e.label || maskKey(e.key), keyMask: maskKey(e.key), keySource: e.source, ok: false };
    const rNotes = [];
    try {
      const usageRes = await fetchUsage(e.key, opts, rNotes);
      const w = extractWindows(usageRes.data);
      r.ok = true;
      r.endpoint = usageRes.url;
      r.windows = { rolling: j(w.rolling), weekly: j(w.weekly), monthly: j(w.monthly) };
      r.anyRateLimited = Object.values(w).some((x) => x && x.status === 'rate-limited');
      if (opts.console) {
        try {
          const cr = await get(CONSOLE_STATUS, e.key, opts.timeout);
          if (cr.status === 200) {
            try { r.console = extractConsole(JSON.parse(cr.text)); }
            catch { rNotes.push('console 接口返回非 JSON，跳过'); }
          } else {
            rNotes.push('console 接口 HTTP ' + cr.status + '，跳过订阅/金额信息（该接口非公开文档，可能变化）');
          }
        } catch (ce) {
          rNotes.push('console 接口请求失败: ' + ((ce && ce.message) || String(ce)));
        }
      }
    } catch (e2) {
      r.error = (e2 && e2.message) || String(e2);
    }
    r.notes = rNotes;
    results.push(r);
  }

  const failed = results.filter((r) => !r.ok).length;
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      ok: failed === 0,
      tool: 'opencode-go-quota',
      version: VERSION,
      checkedAt: new Date().toISOString(),
      mode: 'multi',
      summary: { total: results.length, ok: results.length - failed, failed },
      results,
      notes,
    }, null, 2) + '\n');
  } else {
    renderMulti(results, notes);
  }
  process.exit(failed === 0 ? 0 : 2);
}

main().catch((e) => die(2, '未捕获错误: ' + ((e && e.message) || String(e))));
