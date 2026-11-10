# dsh-opencode-quota-mcp

把 tooLib/opencode-quota-mcp 的 stdio MCP 服务（包装 opencode Go 配额查询 CLI v1.2.0，多 key 名册）以纯配置 bundle 接进 DeepSeek Harness——本包不含业务代码，只装配置。

- 安装（路线 A，本地路径）：`plugin_manager install_bundle "E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp"`（或 `dsh plugin --profile <profile> add file:E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp`）。
- 安装（路线 B，从 GitHub 装整个仓库，组合包声明在仓库根 `package.json`）：`plugin_manager install_bundle "https://github.com/AbsoluteHLN/opencode-go-quota"`；仓库为私有库，机器上需已有访问凭据。
- 两条路线插的是同一条 patch（id `opencode-quota-mcp`），**装一条就够**，重复装会出现两条同名条目。
- serverName 别改：工具名固定为 `mcp__opencode__quota_check`，改一次所有历史会话引用与权限规则跟着失效。
- 前提：把各人 key 按模板填进 `E:\KalciriteTools\tooLib\opencode-quota-mcp\opencode-go-keys.txt`（一人一行，`|` 分隔标签与 key）——key 走文件不从对话收，server 只透传路径不读内容。**名册由持 key 的本人（或被指派的人）自己填，写工具的人不代填，也不要把 key 贴进聊天窗口**；填写步骤见 `tooLib/opencode-quota-mcp/README.md` 的「名册由谁填（交接给另一位同学）」一节。名册文件不存在时 server 自动交给 CLI 走 7 级自动发现链，不会因为缺文件而起不来。
- 纪律与用法在 server 的 instructions 里（随 tools/list 注入宿主）；离线自检：`node --test E:\KalciriteTools\agent-adapters\dsh-opencode-quota-mcp\tests\probe.test.mjs`。
