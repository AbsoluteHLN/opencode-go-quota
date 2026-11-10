# opencode-quota-mcp

opencode Go 订阅配额查询工具包：零依赖 CLI（v1.2.0，多 key 名册）+ 一层 stdio MCP 包装，
供 DSH 等宿主以 `mcp__opencode__quota_check` 查询「5 小时 / 周 / 月」三个用量窗口。
另附一个可选的桌面浮窗（tkinter），把同一份数据以卡片形式常驻桌面。

分层：**MCP server 不实现任何 quota 逻辑**，每次工具调用 spawn 同包 CLI 副本
（按需 `--json` / `--console` + `--keys-file`），复用 CLI 的全部 key 解析链与渲染；
CLI exit 0（全成功）与 exit 2（部分 key 失败、结果仍完整）都按正常结果返回，
exit 1（参数/名册错误）与超时才报 isError。key 全程只活在名册文件里，输出一律掩码。

## 目录

| 路径 | 说明 |
| --- | --- |
| `bin/opencode-go-quota.mjs` | CLI v1.2.0（`temp/opencode-go-quota.mjs` 的字节一致副本） |
| `bin/mcp-server.mjs` | stdio MCP 入口薄壳（argv 解析 / 诊断 / 退出） |
| `src/mcp.mjs` | JSON-RPC 2.0 协议面（照抄已验证的 `tooLib/web-search-mcp` 骨架） |
| `bin/quota-widget.pyw` | 可选：桌面浮窗（tkinter），单击收起/展开、拖动记位 |
| `opencode-go-keys.example.txt` | 名册模板（纯注释，无真实 key；复制成运行时名册再填 key） |
| `opencode-go-keys.txt` | 运行时名册落点（默认名册；已 gitignore，真实 key 只落这里） |

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
甲|oc_在这里粘贴你的第一把Go_Key
乙|oc_在这里粘贴你的第二把Go_Key
```

### 名册由谁填（交接给另一位同学）

名册里的真实 key **不由写工具的人代填**，由持 key 的本人（或被指派的人）自己填。
key 只落在本机的名册文件里：不进对话、不进提交、不进仓库。

1. 建名册文件（模板就是同目录的 `opencode-go-keys.example.txt`）：

```powershell
Copy-Item tooLib/opencode-quota-mcp/opencode-go-keys.example.txt tooLib/opencode-quota-mcp/opencode-go-keys.txt
```

2. 编辑 `opencode-go-keys.txt`，一人一行、`|` 分隔标签与 key（见上节格式）：

```text
甲|oc_在这里粘贴你的第一把Go_Key
乙|oc_在这里粘贴你的第二把Go_Key
```

3. 填完自己验一下（输出只有掩码标签和百分比，不会打印 key 值）：

```powershell
node tooLib/opencode-quota-mcp/bin/opencode-go-quota.mjs
```

4. 提交前再确认名册没被带进仓库：`git status` 里不应出现 `opencode-go-keys.txt`
   （`.gitignore` 已挡这个文件名，但自己再看一眼更稳）。

**没填会怎样**：名册文件不存在时 MCP server 不会起不来——它把 key 发现交给 CLI 的自动发现链
（env / auth.json / dsh credentials / minimax config）；一条都没发现时，工具调用返回 isError
并说明「没找到 key」，不会静默返回空。

**换 key / 加人**：改同一个名册文件就行，不用重装插件——名册是每次工具调用现读的。

**别做的事**：不要把 key 贴进聊天窗口、issue、截图或任何提交里。server 侧也有同一条纪律
（instructions 随 tools/list 注入宿主）。

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

## 桌面浮窗（可选）

```text
pythonw bin/quota-widget.pyw
```

- 无控制台黑窗；常驻桌面显示「共享池」与「本 key 自用」两段已用%。
- 单击收起/展开（收起态与展开态同宽同栅格）、拖动记位、双击刷新、右键菜单退出。
- 视觉走 KalciriteUI v4「folio-graphite」令牌；数值口径与 CLI 完全一致。
- 浮窗内嵌本机绝对路径（node 与 CLI 位置），属本机部署件，不是跨机通用件。

## 与 temp/ 原件的关系

`temp/opencode-go-quota.mjs` 是 v1.2.0 原件与回归基线，`bin/opencode-go-quota.mjs` 是它的
字节一致副本。CLI 后续改动请两份同步（或只改 tooLib 副本后回填），当前两者 SHA-256 一致。
