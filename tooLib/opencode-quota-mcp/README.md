# opencode-quota-mcp

opencode Go 订阅配额查询工具包：零依赖 CLI（v1.1.0，多 key 名册）+ 一层 stdio MCP 包装，
供 DSH 等宿主以 `mcp__opencode__quota_check` 查询「5 小时 / 周 / 月」三个用量窗口。

分层：**MCP server 不实现任何 quota 逻辑**，每次工具调用 spawn 同包 CLI 副本
（按需 `--json` / `--console` + `--keys-file`），复用 CLI 的全部 key 解析链与渲染；
CLI exit 0（全成功）与 exit 2（部分 key 失败、结果仍完整）都按正常结果返回，
exit 1（参数/名册错误）与超时才报 isError。key 全程只活在名册文件里，输出一律掩码。

## 目录

| 路径 | 说明 |
| --- | --- |
| `bin/opencode-go-quota.mjs` | CLI v1.1.0（`temp/opencode-go-quota.mjs` 的字节一致副本） |
| `bin/mcp-server.mjs` | stdio MCP 入口薄壳（argv 解析 / 诊断 / 退出） |
| `src/mcp.mjs` | JSON-RPC 2.0 协议面（照抄已验证的 `tooLib/web-search-mcp` 骨架） |
| `opencode-go-keys.example.txt` | 多 key 名册模板（使用时复制为 `opencode-go-keys.txt`；真实 key 永不入库，运行时名册已被 .gitignore 挡住） |

## CLI 用法

```text
node bin/opencode-go-quota.mjs [--key K]... [--key-file F] [--keys-file R]... [--console] [--json] [--help]
```

- `--key <KEY|标签|KEY>`：指定 key，可重复（多把按顺序逐人查询，单把失败不中断）
- `--key-file <PATH>`：从文件读单个 key
- `--keys-file <PATH>`：多 key 名册，可重复传多个
- `--console`：附带 console 订阅状态（套餐期 / 支付方式 / 微美分精确用量，1e8 = US$1）
- `--json`：结构化输出（单 key 扁平 `mode:"single"`；多 key `{ok, mode:"multi", summary, results, notes}`）
- 退出码：**0** 全成功；**1** 参数/名册文件错误；**2** 任一 key 查询失败（结果仍完整）
- 用量接口地址可用 env `OPENCODE_GO_USAGE_URL` 覆盖

### 名册格式（opencode-go-keys.txt）

一人一行，`|` 是唯一分隔符；`#` 开头的行是注释，空行忽略，行内 ` #` 之后视为注释，
自动剥 BOM 与成对引号；key 里含空白直接报错退出（带行号）：

```text
# 注释行
甲|oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
乙|oc_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
```

### key 解析优先级

显式传参（--key / --key-file）> 名册（--keys-file，或 CLI 同目录自动发现）>
env `OPENCODE_GO_API_KEY` > `OPENCODE_AUTH_CONTENT` > auth.json > dsh credentials > minimax config

## MCP 工具面

- server 命名空间：`opencode`；工具：`quota_check`；宿主侧工具名：`mcp__opencode__quota_check`
- 参数：`format`（`table` 默认 / `json`）、`console`（bool，附带订阅状态）
- 多 key 名册逐人串行查询，单把失败不影响其他人，按人一行汇总（失败行标注错误），key 一律掩码
  （≤12 位全打星，否则前 4 位 + … + 后 4 位）
- 安全面：server 不读名册内容，只把路径透传给 CLI；stderr 诊断只打名册路径与 exists 布尔；
  不向模型暴露路径参数；新增成员 / 换 key 直接编辑名册文件，不从对话里收 key

## 接入 DSH

装接入包（纯配置，无代码，本体在本包）：

```text
plugin_manager install_bundle "E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp"
```

装完在对话里调 `mcp__opencode__quota_check` 验证。用法纪律写在 server 的
`instructions` 里（宿主注入系统提示），不写进人设。

## 与 temp/ 原件的关系

`temp/opencode-go-quota.mjs` 是 v1.1.0 原件与回归基线，`bin/opencode-go-quota.mjs` 是它的
字节一致副本。CLI 后续改动请两份同步（或只改 tooLib 副本后回填），当前两者 SHA-256 一致。
