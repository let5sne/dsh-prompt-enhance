# @let5sne/dsh-prompt-enhance

给 DeepSeek Harness 的输入区加一个五角星按钮：点击后用**默认模型**把当前草稿改写成更清晰、更具体、可直接执行的提示词，并替换草稿。

## 功能

- 在 composer 工具行、**模型选择器左侧**放一个 28px 星标（槽位 `conversation.input.right`）。
- 读的是 Session 输入的标准 props（`useInput` / `inputActions`），不读别的插件的 DOM。
- 结果用 `inputActions.setDraft()` 写回，一步 undo。
- 如果等待期间草稿被改动：不覆盖，星标变实心，下一次点击才替换（显式确认）。
- 忙碌时转圈；失败时按钮上方弹错误气泡 8 秒；空草稿 / 发送中 / 输入锁定时禁用。
- 文案走 DSH 的 Client locale 服务（`en` / `zh`）。

## 安装

```sh
# 从 Git（需要 DSH 0.2.x，纯 JS 包，安装时不需要构建授权）
dsh plugin --profile <profile> add github:let5sne/dsh-prompt-enhance

# 或钉住版本
dsh plugin --profile <profile> add "github:let5sne/dsh-prompt-enhance#v1.0.0"
```

安装后出现在 插件 页的已安装列表里；确保该行是启用状态。

## 使用

1. 在输入区随便写点东西（越草稿越好）；
2. 点模型选择器左边的五角星；
3. 等它转完，草稿就被替换成增强后的提示词。

模型取自 **设置 → 模型** 里的默认模型（Host 侧 `agentDefaultModel`）。每次点击是一次额外的模型请求，草稿内容会发给该模型服务商。

## 它怎么工作

- **Host 半边（`index.js`）**：注册一个包自己的 JSON 路由 `POST /dsh-prompt-enhance/enhance`（`ctx.webServer`），用 `ctx.llm.stream()` 调默认模型，`system` 是一条提示词工程指令，返回改写后的纯文本。请求体上限 16 KB、草稿上限 6000 字、单次调用 45 s 超时，并校验 `Origin` 必须与 `Host` 同源。
- **Client 半边（`client.js`）**：`ctx.slots.inject('conversation.input.right', ...)` 挂载按钮；通过相对 `fetch` 调用上面那条路由；读写草稿只走 `inputActions` / `useInput`。

包不依赖任何 `@deepseek-ai/*` 包，也不用 `dsh.client.external`。

## 目录

| 路径 | 说明 |
|---|---|
| `index.js` | Host 半边：路由 + 模型调用 + 系统提示词（`SYSTEM_PROMPT`） |
| `client.js` | Client 半边：星标按钮与三态 |
| `cordis.patch.yml` | 组合包 patch（插入一行 `prompt-enhance`） |
| `locale/*.json` | 插件管理页的标题与描述 |
| `docs/` | 插件详情页文档与预览图 |
| `market/index.json` | 本插件的插件市场索引条目（format 1） |
| `catalog/awesome-dsh-plugin-entry.yml` | 提交给 `awesome-dsh-plugin` 的条目草稿 |

## 作为市场索引源

```
https://let5sne.github.io/dsh-prompt-enhance/market/index.json
```

在 插件 → 实验性插件 → 打开「自定义插件索引」→ 发现 → 添加索引源，填上面的地址即可搜索并安装。

## 兼容性

- `engines.dsh: ">=0.2.0-rc.2"`（在 0.2.2-rc.1 上开发与验证）。
- 需要 Web GUI 进程提供 `ctx.webServer` 与 `ctx.llm`；没有 `agentDefaultModel` 时按钮会报错而不是静默失败。

## 许可证

MIT，见 [LICENSE](LICENSE)。