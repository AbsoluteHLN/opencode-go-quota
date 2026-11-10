# opencode-go-quota

opencode Go 订阅配额查询工具包：零依赖多 key CLI（v1.2.0）+ 一层 stdio MCP server +
DSH 接入 bundle。查询「5 小时 / 周 / 月」三个用量窗口，多 key 名册逐人串行查询，
单把失败不中断，输出一律掩码。

三个组成部分：

- **CLI**（`tooLib/opencode-quota-mcp/bin/opencode-go-quota.mjs`）：零依赖 Node 脚本，
  7 级 key 解析链（显式参数 > 名册 > env > auth.json > dsh credentials > minimax config），
  无参数裸跑即可自动发现本机已配置的 opencode-go key。
- **MCP stdio server**（`tooLib/opencode-quota-mcp/bin/mcp-server.mjs`）：不实现任何
  quota 逻辑，每次工具调用 spawn 同包 CLI 副本，复用 CLI 的全部 key 解析链与渲染。
- **DSH 接入 bundle**（`agent-adapters/dsh-opencode-quota-mcp/`）：纯配置（MCP bundle +
  cordis patch + 双语 locale），装完在对话里调 `mcp__opencode__quota_check`。

另附一个**可选的桌面浮窗**（`tooLib/opencode-quota-mcp/bin/quota-widget.pyw`，tkinter）：
同一份数据以卡片形式常驻桌面，单击收起/展开。本机部署件，内嵌本机绝对路径。

## 目录结构

```text
tooLib/opencode-quota-mcp/            # 工具本体（CLI + MCP stdio server）
  bin/opencode-go-quota.mjs           # CLI v1.2.0（多 key 名册循环）
  bin/mcp-server.mjs                  # stdio MCP 入口薄壳（argv / 诊断 / 退出）
  bin/quota-widget.pyw                # 可选：桌面浮窗（tkinter，单击收起/展开）
  src/mcp.mjs                         # JSON-RPC 2.0 协议面
  opencode-go-keys.example.txt        # 多 key 名册模板（纯注释，无真实 key）
agent-adapters/dsh-opencode-quota-mcp/  # DSH 接入 bundle（纯配置）
  package.json / cordis.patch.yml / locale/{zh,en}.json / README.md
  tests/probe.test.mjs                # 离线协议探针（node --test，零网络零名册）
```

## 快速开始

### 1. 准备名册（可选）

多 key 场景把模板复制为运行时名册，再按格式填入各人 key（一人一行，`|` 分隔）：

```powershell
Copy-Item tooLib/opencode-quota-mcp/opencode-go-keys.example.txt tooLib/opencode-quota-mcp/opencode-go-keys.txt
```

`opencode-go-keys.txt` 已被 `.gitignore` 挡住，不会被提交。单人场景可以不建名册——
CLI 会沿 7 级解析链自动发现本机 key（env / auth.json / dsh credentials / minimax config）。

### 2. 直接用 CLI

```text
node tooLib/opencode-quota-mcp/bin/opencode-go-quota.mjs             # 自动发现 key，表格输出
node tooLib/opencode-quota-mcp/bin/opencode-go-quota.mjs --json      # 结构化输出
node tooLib/opencode-quota-mcp/bin/opencode-go-quota.mjs --console   # 附带订阅状态
node tooLib/opencode-quota-mcp/bin/opencode-go-quota.mjs --help      # 全部参数
```

退出码：0 全成功；1 参数/名册错误；2 任一 key 查询失败（结果仍完整）。

### 3. 起 stdio MCP server

```text
node tooLib/opencode-quota-mcp/bin/mcp-server.mjs [--cli PATH] [--keys-file PATH]...
```

server 命名空间 `opencode`，工具 `quota_check`（参数 `format`: table/json、`console`: bool）。
key 不出本机：server 不读名册内容，只把路径透传给 CLI；输出只出掩码。

### 4. 接入 DSH

两条路线**二选一**：插入的是同一个 patch（id `opencode-quota-mcp`），重复安装会出现
两条同名 patch 条目，装过一条就不要再装另一条。

路线 A：本地路径安装（装 `agent-adapters/` 子目录）：

```text
plugin_manager install_bundle "<仓库路径>\agent-adapters\dsh-opencode-quota-mcp"
```

路线 B：从 GitHub 安装（装整个仓库，组合包声明在仓库根 `package.json`，指向同一条
patch）：Web 插件页直接贴仓库 URL，或用命令行给 git 地址：

```text
plugin_manager install_bundle "https://github.com/AbsoluteHLN/opencode-go-quota"
```

装完在对话里调 `mcp__opencode__quota_check` 验证。`cordis.patch.yml` 里的绝对路径是
部署示例，按本机实际路径调整。

### 跑探针测试

```text
node --test agent-adapters/dsh-opencode-quota-mcp/tests/probe.test.mjs
```

零网络、零名册（CLI 子进程换成临时目录里的假脚本），只验证 MCP 协议面与 exit 契约。

### 5. 可选：桌面浮窗

```text
pythonw tooLib/opencode-quota-mcp/bin/quota-widget.pyw
```

单击收起/展开、拖动记位、双击刷新、右键退出；数据与 CLI 同源同口径。

## 密钥纪律

- 真实 key 只落运行时名册 `opencode-go-keys.txt`（gitignore 挡住）或本机密钥配置，
  不进对话、不进日志、不进仓库。
- 所有输出（表格 / JSON / stderr 诊断）只出掩码：≤12 位全打星，否则前 4 位 + … + 后 4 位。
- 仓库内只提交纯净模板 `opencode-go-keys.example.txt`。
