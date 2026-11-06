# dsh-opencode-quota-mcp

把 tooLib/opencode-quota-mcp 的 stdio MCP 服务（包装 opencode Go 配额查询 CLI v1.1.0，多 key 名册）以纯配置 bundle 接进 DeepSeek Harness——本包不含业务代码，只装配置。

- 安装：`plugin_manager install_bundle "E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp"`（或 `dsh plugin --profile <profile> add file:E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp`）。
- serverName 别改：工具名固定为 `mcp__opencode__quota_check`，改一次所有历史会话引用与权限规则跟着失效。
- 前提：把各人 key 按模板填进 `E:\KalciriteTools\tooLib\opencode-quota-mcp\opencode-go-keys.txt`（一人一行，`|` 分隔标签与 key）——key 走文件不从对话收，server 只透传路径不读内容。
- 纪律与用法在 server 的 instructions 里（随 tools/list 注入宿主）；离线自检：`node --test E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp\tests\probe.test.mjs`。
