# dsh-gpt-niang · DSH 桌宠额度挂件

[DSH](https://github.com/deepseek-ai)（DeepSeek Harness）原生插件：在 **Web UI 和 Desktop 的页面右下角**
挂一只可拖拽的桌宠——能拖、能抛、能散步、会打瞌睡、偶尔冒一句话；点一下弹出
**OpenAI / Codex 订阅额度**气泡（5 小时窗口 + 周上限、模型级可用性、积分与附加额度池，
分区可折叠，警戒线响告警音）。额度由宿主侧插件直连 ChatGPT 后端取得，**令牌一步都不进浏览器**。

- 纯 DSH 插件：不依赖 Codex 桌面端、不需要本机装 Node 或 PowerShell、不写开机自启、不注册计划任务
- 代码 MIT；角色立绘沿用上游素材声明（见「素材与许可」），仅供个人非商业使用
- 灵感来自 [T7moris/GPT-Niang](https://github.com/T7moris/GPT-Niang)（Codex 桌面插件 + WPF 挂件），
  本仓库是从零重写的 DSH 插件，只沿用了它的角色立绘，未使用其代码

## 安装 / 卸载

```bash
git clone https://github.com/<你的账号>/dsh-gpt-niang.git

# 安装（写工作区之外，需要 danger-full-access）
dsh plugin --profile desktop add 'link:<克隆下来的绝对路径>'

# 卸载
dsh plugin --profile desktop remove dsh-gpt-niang
```

装完**重启 DSH Desktop**（或刷新 Web UI）才会加载新 bundle；改 link 目录里的代码同样只需重启。
本插件没有 `@deepseek-ai/dsh*` peer 依赖，不会被 profile 的兼容性闸门拦下。

## 前置条件

需要有 OpenAI Codex 的登录凭据，任一即可（按优先级）：

1. 插件 `dsh-codex-provider` 管理的凭据（DSH 模型设置里登录 OpenAI Codex 后写入
   `%DSH_HOME%\.credentials.yaml` 的 `OPENAI_CODEX_API_KEY`）；
2. `llm-pi-ai/openai-codex` 记录；
3. `$CODEX_HOME\auth.json` 或 `~/.codex/auth.json`。

都没有时气泡会直接提示「尚未登录 OpenAI Codex」，不会静默失败。

## 桌宠交互

| 操作 | 效果 |
| --- | --- |
| 左键点击 | 开/关额度面板，角色蹦一下并「叮」一声 |
| 拖拽 | 跟着指针走，身体按速度倾斜（±13°） |
| 松手（有位移） | **抛出去**：重力 2100px/s²、撞墙/落地反弹并带摩擦，停下后记住落点 |
| 右键 | 8 项菜单（见下表） |
| 放着不管 5 分钟 | 打瞌睡，头顶飘 `Z z`；点一下先「唔…我醒了」，第一下只唤醒不开面板 |

落点、缩放、折叠状态、音效开关全部记在 localStorage；**重力只在被抛出后的飞行阶段生效**，
所以手动把角色摆到半空它也不会自己掉下去。

右键菜单：

| 项 | 作用 |
| --- | --- |
| 刷新额度 | 强制刷新（绕过 45s 缓存） |
| 散步：开 / 关 | 沿窗口底部来回走，走走停停（默认关） |
| 闲聊：开 / 关 | 每 1.5–4 分钟冒一句话，额度紧张时换语气（默认开） |
| 放大一点 / 缩小一点 | 缩放 0.75–1.6 |
| 音效：开 / 关 | 点击「叮」声 |
| 告警音：开 / 关 | 额度警戒时的提示音（独立开关） |
| 复位位置 / 复位大小 | 回到右下角默认 |

角色图加载失败（例如路由拿不到 PNG）会自动退回内联 SVG 小人，不会留一个破图占位。

## 额度面板

打开时强制刷新一次，之后每 60s 轮询；Esc 或点空白处关闭：

- **5 小时窗口 / 周上限**：百分比 + 进度条 + 重置时间（`MM-DD HH:mm（N 小时后）`）
- **模型用量**：按模型列出可用性。`model_usage` 只给「是否可用 / 何时可用 / 是否需积分」，
  所以默认显示状态 chip（`可用` / `x 可用` / `需积分` / `不可用`）；
  **只有当接口真的下发了百分比时才画进度条**，绝不编造数字
- **积分与附加**：余额、超额是否已达上限、花费控制、附加额度池（有则显示）
- 每个分区点标题栏即可折叠，折叠状态记在 localStorage

**配色与告警**：剩余 ≤30% 变黄、≤10% 变红并让角色轻微抖动、状态点呼吸。
告警音只在**变差跨线**时响一次（10% 警戒三连降调，30% 警戒两连音），
额度恢复后再次掉下去还会重新响——不会每轮轮询都吵你。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-gpt/widget.js` | 挂件脚本（45s 或 7d 缓存） |
| GET/HEAD | `/dsh-gpt/pet.png` | 角色立绘，带 ETag + `max-age=86400`，命中 `If-None-Match` 回 304 |
| GET/POST | `/dsh-gpt/quota` | 额度快照；GET 45s 缓存，POST 强制刷新 |

三条路由都做 Host 头防 DNS-rebinding 校验；额度与脚本路由只允许回环地址
（127.0.0.1 / ::1），其它方法 405，非回环 403。立绘 ETag 由 `size-mtime` 生成，换图后普通刷新即可生效。

`GET /dsh-gpt/quota` 返回（`models` / `credits` / `spend` / `additional` 无数据时省略）：

```json
{
  "ok": true,
  "fetchedAt": 1792769304735,
  "account": "a23***@gmail.com",
  "plan": "plus",
  "windows": [
    { "window": "primary_window", "label": "5 小时窗口", "remaining": 62, "used": 38, "resetsAt": "2026-10-23T19:37:21.000Z" },
    { "window": "secondary_window", "label": "周上限", "remaining": 52, "used": 48, "resetsAt": "2026-10-29T17:45:05.000Z" }
  ],
  "models": [
    { "name": "gpt-6-astra", "available": true, "availableAt": null, "creditsWouldEnable": false }
  ],
  "credits": { "hasCredits": false, "unlimited": false, "overageLimitReached": false, "balance": "0" },
  "spend": { "reached": false, "limit": null },
  "additional": []
}
```

失败时统一返回 `{ "ok": false, "error": "<固定中文文案>", "windows": [] }`，
**不转发上游 body、不回显令牌**。

## 素材与许可

- 代码：MIT，见 [`LICENSE`](LICENSE)
- 角色立绘 `assets/pet/gpt-dragon-niang.png`（1254×1254 RGBA）来自
  [T7moris/GPT-Niang](https://github.com/T7moris/GPT-Niang)，**不适用 MIT**，
  随包原样保留了原作者的使用声明与生成说明：
  [`assets/pet/CHARACTER-NOTICE.txt`](assets/pet/CHARACTER-NOTICE.txt)、
  [`assets/pet/GENERATION-NOTES.md`](assets/pet/GENERATION-NOTES.md)
  - 允许范围：随本项目及其非商业副本，作为挂件或项目说明的一部分展示和分发，保留声明与来源
  - 不允许：商业产品、广告、周边销售、收费素材包等商业用途，以及作为独立素材包分发
  - 参考角色、参考图与可能涉及的第三方权利仍归各自权利人
- 音效：WebAudio 现场合成，不含任何音频文件
- 台词：自写

因此本仓库按**个人非商业用途**使用。要商用或做素材包分发，请先替换立绘：把任意 PNG 覆盖成
`assets/pet/gpt-dragon-niang.png` 即可（路由按 `size-mtime` 生成 ETag，刷新即生效），
或删掉它让插件退回内联 SVG 小人。

## 结构

```
cordis.patch.yml               # Bundle patch：把 dsh-gpt-niang 插进插件表
lib/index.js                   # 宿主半区：注入行、3 条路由、凭据、45s 缓存 + 单飞、payload 解析
assets/gpt-niang.js            # 客户端半区：纯 IIFE，桌宠行为 + 可折叠气泡 + WebAudio 音效
assets/pet/gpt-dragon-niang.png # 角色立绘（不适用 MIT，见「素材与许可」）
assets/pet/CHARACTER-NOTICE.txt # 上游立绘授权声明（原样保留）
assets/pet/GENERATION-NOTES.md  # 上游立绘生成说明（原样保留）
test/widget.test.js            # 25 项单元测试（node --test）
```

关键点：`apply()` 里**第一件事**就同步注册 `root.on('webserver/index-inject', ...)`。
Desktop 端的注入表在宿主启动时只收集一次，晚注册的行永远进不了表（这也是
`dsh-whale-widget` 踩过的坑）；注入行必须用内联 `script` 行而不是 `script-src` 行，
因为后者加载失败会 reject `__DSH_BOOT_READY__` 把整个应用带崩。

解析层是**纯函数**（`toModelRow` / `parseModels` / `parseCredits` / `parseSpend` /
`parseAdditional`），全部有单测覆盖信任边界：上游给什么就显示什么，缺字段就不显示，
`individual_limit: null` 不会被 `Number()` 误转成「上限 0」。

## 测试

```bash
node --test --test-isolation=none test/widget.test.js
```

25 项单测覆盖：窗口映射与重置时间、账号脱敏、注入行去重、三条路由的 403/405/304/200、
缺凭据不抛错、上游畸形数据的容错、立绘路由的 ETag 协商。

必须加 `--test-isolation=none`：DSH 沙箱下默认的进程隔离会 `spawn EPERM`。

另有一套真浏览器验收装置（不在本仓库）：把 desktop profile 镜像成临时 profile 起宿主 +
headless Chrome，再用 CDP 做 23 项交互检查（立绘加载、点击开面板、折叠切换、抛掷位移、
散步开关、菜单项），并截图比对。
