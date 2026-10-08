<p align="center">
  <img src="docs/logo.png" width="96" alt="agentwatch logo"><br>
  <b>agentwatch</b><br>
  长时运行 AI 编程任务的守护进程
</p>

<p align="center">
  <a href="https://github.com/piemvibes-hue/agentwatch/actions/workflows/ci.yml"><img src="https://github.com/piemvibes-hue/agentwatch/actions/workflows/ci.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen" alt="node>=18">
  <img src="https://img.shields.io/badge/deps-0-blue" alt="零依赖">
</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

**断了续，死了报。** 为长跑 AI 编程任务而生的看门狗 —— 目前支持 OpenAI Codex（CLI、桌面端、exec，它们共用 `~/.codex`）。

让 Codex 任务挂着跑一晚上。当流断开、撞到用量限额、服务端 429、或者线程悄悄卡死时，agentwatch 能检测到，通过官方 `codex queue` 命令把**同一条线程**续起来，并验证它真的恢复产出了；实在救不活，才会推送通知叫醒你。

<p align="center"><img src="docs/demo.gif" alt="agentwatch 救活两条死掉的 codex 线程" width="720"></p>

## 工作原理

双层检测（结构化优先，文本兜底）：

```
~/.codex/*.sqlite    logs_2：按线程的 ERROR/WARN 日志行 → 规则引擎
  （需 Python）       goals_1：thread_goals.status = usageLimited → /goal resume
                      state_5：threads.updated_at_ms + source → 活跃信号/验证/路由
                      thread_history_1：按 turn 的状态 —— failed 带 error_json；
                                        孤儿 inProgress = 中途暴毙
~/.codex/sessions/**/rollout-*.jsonl   （始终开启 —— 尾读 + 启动时尾部回放）
        │  每条信号 → rules.json（热更新）
        ▼
  失效分类 → 动作
        │  wait_reset：解析 reset 时间，reset+2 分钟后续跑
        │  queue：     codex queue --thread <UUID> --message "Continue"
        │  exec-resume:codex exec resume <UUID> "Continue"（source=exec 线程）
        │  notify：    只告警          ignore：fail-closed，绝不重试
        ▼
  验证：5 分钟内有新的 rollout/日志/线程活动 → 已恢复 ✓
        │  没有 → 重试（最多 3 次）→ 还不行 → 推送"抢救无效"通知
```

- **不动 GUI、不包 PTY、不猜 `--last`。** 按线程的 `source` 自动路由：交互/桌面线程走 `codex queue --thread <uuid>`（官方投递口）；无头 `exec` 线程走 `codex exec resume <uuid>`（新进程里真跑一个 turn）。可用 rules.json 里 `recoveryMethod: "queue"|"exec-resume"` 强制指定。queue 投递后验证窗口内无活动——说明消息没人消费（没有任何客户端持有该线程）——auto 模式自动降级 exec resume 再试，不白烧重试次数。
- **fail-closed。** 只有已知的可恢复失效才重试（断流、429、过载、5xx、超时、限额、假死）。配置类永久错误（`model_not_found`、key 失效、账户冻结）只告警不硬试；用户主动取消和内容拦截一律不碰。

*已在真实 codex-cli 0.161.0 + Windows Server 2022 验证：杀掉一个 exec turn 后被识别为孤儿 `inProgress`，经 `codex exec resume` 复活成真实 `completed` turn，下一轮 poll 标记 recovered。`codex queue` 证实投递到 `queue_1.sqlite`（仅当某客户端持有该线程时才会被消费）。*
- **历史尸体也能捞。** 启动时会检查每个 rollout 文件尾部——凌晨 3 点死的任务，早上 8 点开守护照样救得起来。
- **状态持久化**在 `~/.agentwatch/state.json`——重启不丢已排定的恢复。

## 一行安装

```powershell
# Windows（PowerShell）：
iwr https://raw.githubusercontent.com/piemvibes-hue/agentwatch/main/install.ps1 | iex
```
```sh
# macOS / Linux：
curl -fsSL https://raw.githubusercontent.com/piemvibes-hue/agentwatch/main/install.sh | sh
```

这一行会 clone 到 `~/.agentwatch/app`、注册登录自启（schtasks / launchd / systemd）、并**立即启动**守护进程——看板在 http://127.0.0.1:8787。`node ~/.agentwatch/app/src/cli.js uninstall` 一键卸载。要求：Node 18+、PATH 里有 `codex`、git。

已 clone 的话，`node src/cli.js install` 同样完成注册。

## 用法

```bash
# 需要 Node 18+，PATH 里有 codex（随 Codex CLI / 桌面端自带）

node src/cli.js install                    # 一键：注册自启 + 立刻启动
node src/cli.js watch                      # 前台跑守护
node src/cli.js watch --serve              # + 本地看板 http://127.0.0.1:8787
node src/cli.js watch --ntfy my-topic      # + ntfy.sh 手机推送
node src/cli.js watch --webhook https://…  # + POST {text,title,detail} JSON
node src/cli.js watch --dry-run            # 只检测和排程，不真执行
node src/cli.js run codex exec "…"         # 在守护下跑 codex 命令
node src/cli.js run codex                  # 交互 TUI 也能包
node src/cli.js scan                       # 一次性状态表
node src/cli.js status                     # 持久化的守护状态
```

**看板**：`--serve` 给一个实时页面（线程状态、恢复尝试、事件流），只绑 localhost，零依赖；页面随浏览器语言自动中英切换。

**通知语言**：默认英文，`AGENTWATCH_LANG=zh` 切换为中文通知（也自动识别系统语言）。

**Codex plugin**：本仓库同时是一个 [Codex plugin](https://developers.openai.com/codex/plugins)——`.codex-plugin/plugin.json` + `skills/agentwatch/` 教会 Codex agent 怎么给自己的长任务上守护。把仓库加进 Codex 插件目录，对它说"装上 agentwatch"就行。

在你机器上的第一次真实运行：

```bash
node src/cli.js watch --dry-run --verbose
```

挂一天看日志——它会把每条 rollout 行的规则判定打出来但不碰任何东西。判定没问题就去掉 `--dry-run`。

使用自定义中转站（而非 ChatGPT 登录）时，`~/.codex/config.toml`：

```toml
model = "your-model"
model_provider = "relay"

[model_providers.relay]
name = "relay"
base_url = "https://your-relay/v1"
env_key = "YOUR_RELAY_KEY_ENV"   # 在跑 codex 和 agentwatch 的同一个环境里 export
wire_api = "responses"           # codex ≥0.160 已删除 chat wire api
```

`codex exec resume` 继承 agentwatch 进程的环境变量——记得在跑守护的会话里 export key。

## 检测覆盖（rules.json）

| 失效 | 匹配样例 | 动作 |
|---|---|---|
| `usage_limit` | "hit your usage limit"、"try again at 6:34 AM" | 提取 reset 时间 → reset+2min 投递（兜底 1h） |
| `stream_disconnected` | "stream disconnected before completion"、传输/解码错误 | 5s 后 queue "Continue" |
| `server_overload` | "servers are currently overloaded"、"model is at capacity" | queue，60s × 2^次数 |
| `rate_limit_429` | "429 Too Many Requests"、"exceeded retry limit" | 60s 后 queue |
| `goal_usage_limited` | `"status":"usageLimited"`（持久 Goal 冻结） | queue `/goal resume` |
| `server_error_5xx`、`timeout` | 5xx、ETIMEDOUT、ECONNRESET | 30s 后 queue |
| `stall` | 最后一条非终态且 7 分钟无新事件 | queue "Continue"（12h 内有效） |
| `permanent_error` | `model_not_found`、key 无效、`insufficient_quota`、账户冻结 | **只通知** —— 配置错误重试没意义 |
| `never_retry` | 用户取消、内容策略、上下文超长 | **不动** |

规则就是 JSON，热更新——Codex 出新的报错文案，改文件不用重启。

## 诚实的限制

- `codex queue` 只在某 Codex 客户端持有该线程时才被消费（实测：消息躺在 `queue_1.sqlite` 等 app 来取）。没有任何客户端持有的线程——无头 exec 任务、重启后的一切——由 `codex exec resume` 复活，agentwatch 按 `threads.source` 自动选。
- Codex 桌面端（`OpenAI.Codex` MSIX）是 GUI——能装上 Windows Server 但窗口起不来。检测/恢复不受影响（共用 `~/.codex`），GUI 本身需要真实桌面会话。
- SQLite 层需要 PATH 里有 `python`/`python3`/`py`（只读 `mode=ro`，WAL 安全）。没有 Python 就退回 rollout 尾读——同样的失效照样抓，粒度粗一点。
- rollout 格式和数据库表名都是非官方的、会漂移——规则按消息文本匹配而非固定字段路径，但 Codex 大版本更新后请用 `watch --verbose` 复查一遍。

## 测试

```bash
node test/run.js   # 32 项断言：rollout+DB 检测→排程→续跑→验证→通知、fail-closed、放弃、turn 级 + exec-resume 路由
```

用假的 `codex` shim + 合成 rollout——不需要装 Codex。

## 路线图

- [ ] Claude Code / Gemini CLI 适配器（同一监视器，换存储层）
- [x] `agentwatch run <cmd>` 监督模式（exec / 交互 TUI）
- [x] 本地看板（`watch --serve`）
- [ ] RunCheck 集成：每次恢复事件上报到 run 结果验证 API
