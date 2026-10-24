# dsh-team-conductor

**一句话定位：** DeepSeek Harness Agent Teams 的统一控制面——一次看清 roster 与每个成员的上下文压力、就地增删与编辑成员、运行时调整成员上限，并把消息送达到按名字寻址不了的非 roster 子代理。

**它叠加，而不是替换内核 team 工具。** 插件只新增六个工具（`team_overview` / `team_member_edit` / `team_capacity_set` / `team_message` / `team_member_add` / `team_member_delete`）、注入一段 prompt 段、安装两个包装型守卫（结算通知去重、已删成员消息拦截）。它不注册同名工具去覆盖内核，也不 `disabled: true` 任何内核行：内核的 `spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_create/list/get/update` 以及 profile 的每一行都原样保留、照常工作。

---

## 目录结构

```
dsh-team-conductor/
├── README.md            # 本文件
├── LICENSE              # MIT
├── package.json         # 包元数据 + dsh.bundle.patch 指向 cordis.patch.yml + dsh.client
├── cordis.patch.yml     # bundle patch：只 insert 一行 team-conductor
├── lib/index.js         # 宿主半边（host half，全部逻辑在这里）
├── lib/client.js        # 浏览器半边（把六个工具渲染成紧凑卡片）
├── scripts/verify-live.mjs  # 断言运行中的进程确实是这一版
├── tests/smoke.mjs      # 自包含 smoke 套件（伪造 cordis ctx 与宿主服务）
└── docs/
    └── ISSUES.md        # 六个上游问题的坐标对照表（现象/根因/本插件能力/需要上游做的事）
```

`package.json` 无任何 `dependencies`；`lib/index.js` 只 import `node:crypto`、`node:os`、`node:path`、`node:fs`（要求 Node ≥ 20）。`lib/client.js` 是纯 JS 的浏览器半边，通过 `window.__ModuleLoader__.load()` 注册，不需要构建。

### 浏览器半边：工具卡片

GUI 的工具卡片是按**工具名**查 `tool.call.toolview` 插槽决定的；没有专属渲染时，结果就是一段原始 JSON。`lib/client.js` 为六个工具各注册一个卡片：

| 工具 | 卡片内容 |
|---|---|
| `team_overview` | 容量一行（已用/上限/剩余）+ 每个成员一行（`displayName` · `availability` · 压力等级/占比），并列出前 3 条 `diagnostics`（如「空闲可复用」提示） |
| `team_member_edit` | `action → 成员`，`taskHandover` 成功/失败（失败带原因），随后是 `effects` 与前 3 条 `warnings` |
| `team_capacity_set` | `上限 before → after` + 占用/剩余/`configured` |
| `team_message` | `kind → 目标` + 投递通道与状态 |
| `team_member_add` | 新成员与状态 + 生效项 |
| `team_member_delete` | 删除对象、内核记录处置（`immutable-active` 等）、名额变化、warnings |

**加载自证：** 客户端半边 apply 时会 `POST /dsh-team-conductor/client-hello`（回环限定），宿主把它记进 `state.clientHalf`，于是状态路由多出两个字段：`clientHalf`（`absent` 或报到时间戳）与 **`clientDiag`**（每个贡献阶段的 `"ok"` / `"error: …"`）。这样"客户端有没有真的加载、哪一步被静默拒绝"都**可以用 curl 验证**，不必看屏幕。`clientDiag` 里出现过两种典型失败：`sidebarRightTabs unavailable`（服务晚绑定、`apply` 时取不到）与 `slot "sidebar.right.pane.tab" is not declared`（直接 `slots.register` 而没有先 `slots.inject` 声明贡献）。

### 设置里的「Agent Team」面板

花名册面板注册在**设置**里，而不是右侧栏 tab：设置是"调整插件"的地方，正是用户去找它的位置；而且 `settings.section` 是**静态声明**的插槽，不需要等 `sidebarRight`/`sidebarRightTabs` 这些晚绑定的服务，也就不会踩上面那个坑。

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "agent-team",
  order: 16,
  label: () => "Agent Team"   // 注意：这个插槽的 label 是函数，不是字符串
}, TeamPanel));
```

面板内容来自 `GET /dsh-team-conductor/team`（每 5 秒轮询）。**团队是按 root 会话隔离的**（roster 在内核里以 root agent 为键，侧车文件也是 `<rootSessionId>.json`），所以这个路由：

- 不带参数时返回**所有活跃团队** `{ ok, teams: [...], selected, sessionId, mismatch }`；
- 带 `?session=<rootSessionId>` 时只返回该会话那一个团队，**匹配不到就给空并置 `mismatch: true`**，绝不静默换一个团队给你看。

浏览器半边会尽力定位"当前会话"（先看 URL 里的 UUID，再在持久化 store `dsh.sessions.current` 的值里搜一个 UUID），定位到就直接显示它的团队；同时只要有**多个**活跃团队就渲染一排选择器（`根会话前 8 位 · 已用名额`），所以任何一个有活跃团队的会话都够得着。

> 能力边界：**团队只在它的 Lead 会话存活时存在**。会话关闭、Lead 被释放后，内核里就没有这支队伍了，面板会显示「无活跃团队」——这不是面板的缺陷。

打开路径：**设置 → Agent Team**。

**注意：** 新增/修改客户端半边需要**重启宿主**（客户端模块在组合期登记），之后按 F5 刷新页面；这与宿主半边"改代码必须重启"是同一类约束。

---

## 安装

Bundle 式安装（把本目录装进 `desktop` profile 的 dependencies 并选中该 bundle）：

```bash
dsh plugin --profile desktop add "file:C:/Users/Little Alety/Documents/deepseek-harness/default-workspace/work/dsh-team-conductor"
```

等价的手工操作是：在 profile 的 `package.json` 里加 `"dsh-team-conductor": "file:<绝对路径>"`，并把 `"dsh-team-conductor"` 追加到 `dsh.profile.bundles` 数组。也可以在 Web 侧边栏的 **Plugins** 页安装/勾选。bundle 的 `dsh.bundle.patch` 会让 profile 应用本包自带的 `cordis.patch.yml`，其中只有一行 `insert: [{ id: team-conductor, name: 'dsh-team-conductor' }]`。

插件在每次组合装载时：为每个 live Team 成员（Lead 与 teammate）的 agent scope 注册六个工具 + 一个 prompt 段，并（在服务可用时）安装两个守卫——结算通知去重（装在激活注册表上）与已删成员消息拦截（装在 `agentTeams.sendMessage` 上）。工具只在 Team 成员的 scope 上注册——非成员 agent 看不到它们。

## 卸载

从 profile 撤下该 bundle：

1. **Web 侧边栏 → Plugins 页**取消勾选 `dsh-team-conductor`，并用该页的卸载动作移除包（其内部执行 `pnpm remove`）。
2. **手工等价操作：** 从 profile 的 `package.json` 的 `dsh.profile.bundles` 数组里删掉 `"dsh-team-conductor"`，再从 `dependencies` 删掉对应条目，然后在该 profile 目录执行 `pnpm install`。bundle 选择只影响 `dsh.profile.bundles`；仅禁用（保留 dependency）不会撤销 bundle。

撤下后六个工具、prompt 段与两个守卫一起消失；侧车状态文件（见下）不会自动删除。

---

## 服务解析：两个作用域

插件自身 `inject` 的只有 `agents` / `tools` / `systemPrompt`，其余服务全是惰性获取。`agentTeams` 从插件 ctx 直接取；`compaction` 与 `subagents` 这类在 shipped profile 里挂在 **`isolate:` 组（Agent 作用域）**下的服务，按「先插件 ctx、取不到再退回 `agent.ctx`」的两段式解析（`lib/index.js` 的 `resolveService()`）。两个作用域都取不到时，`team_overview.diagnostics` 会明说 `compaction is not mounted: action=compact cannot run.`，`action=compact` 会回一条 warning 而不是假装成功。

---

## 六个工具

六个工具都在 Team 成员的 agent scope 上注册，返回约定一致：**单个 `text` 块，其内容是 JSON 文档**。这一输出契约对六个工具都相同（`lib/index.js` 的 `TEXT_OUTPUT_SCHEMA`；`tools.register()` 要求 `output { schema, render }`，见 `@deepseek-ai/dsh-tools/lib/index.js:2878-2886`）。

所有 `parameters` 手写为内核接受的 JSON Schema 子集（`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注解；子集定义见 `@deepseek-ai/dsh-tools/lib/index.js:34-49`），六个工具的参数对象都 `additionalProperties: false`——**多传字段会被拒绝**（`lib/index.js` 的 `assertArgumentShape()` 在每次执行前校验）。

### 1. `team_overview`

一次调用拿到：roster（别名/职责/优先级/标签/是否已退休/是否已删除）、每个成员的上下文占用与饱和等级、容量（已用/上限/剩余/服务中/已退休/已删除/失败/是否已满）、本团队的非 roster 子代理、以及本会话的结算通知账本。它是只读的，不改任何状态。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `include_settlements` | boolean | 否 | 是否包含结算通知账本。默认 true；仅显式传 `false` 才省略。 |
| `include_children` | boolean | 否 | 是否列出本团队的非 roster 子代理作为可寻址目标。默认 true；仅显式传 `false` 才省略。 |
| `include_pressure` | boolean | 否 | 是否测量每个成员的上下文占用。默认 true；传 `false` 时整段跳过（`contextPressure.source` 为 `"skipped"`、`known` 为 false），用于「只要 roster、不想付测量成本」的场合。 |

```json
{ "include_settlements": true, "include_children": true, "include_pressure": true }
```

> **为什么要 `include_pressure`：** 未加载成员的测量要读它的持久日志并造一个 detached 副本，是**每成员一次**的开销。成员多、或只是想知道「谁在、谁在跑」时，`include_pressure: false` 把这次 O(成员数) 的会话工作整段省掉。

返回对象形状（字段全部真实存在，`null` 表示该项未知）：

```
{
  "team": {
    "root": "<root session id>",
    "caller": { "target": "lead" | "<name>", "role": "lead" | "teammate" },
    "capacity": {
      "used": 1, "max": 8, "free": 7,
      "configured": 8,        // profile 配的 maxMembers；取不到为 null
      "serving": 1,           // 未删除的名额占用者
      "retired": 0,           // 已退休且未删除
      "deleted": 0,           // 已删除（墓碑）
      "failed": 0,            // 内核判为 failed 且未删除
      "full": false
    }
  },
  "members": [ {
      "target": "<durable name>", "displayName": "diff-reviewer", "alias": "rev" | null,
      "formerNames": ["reviewer"], "role": "lead" | "teammate",
      "status": "running" | "inactive" | "provisioning" | "failed",
      "description": "...", "originalDescription": "...", "context": "fresh" | "fork" | null,
      "provider": "...", "model": "...", "priority": 5 | null, "tags": ["review"],
      "retired": false, "deleted": false, "deletedAt": null,
      "availability": "lead" | "working" | "idle-ready" | "retired" | "deleted",
      "comments": ["re-briefed 2026-..."], "loaded": true,
      "contextPressure": {
        "known": true, "source": "live" | "persisted" | "unloaded" | "unreadable",
        "tokens": 150000, "contextWindow": 200000, "tokenBudget": null,
        "ratio": 0.75, "remaining": 50000,
        "level": "ok" | "watch" | "near_saturated" | "over" | "unknown",
        "detail": "..."            // 仅当测量失败时出现
      },
      "diagnostics": [ "..." ]
  } ],
  "children": [ { "id": "...", "parent": "<本队 root>", "status": "running" | "inactive",
                  "sameTeam": true, "model": "..." } ],
  "settlements": { "total": 3, "unique": 2, "repeats": [ { "child": "...", "summary": "...",
                     "digest": "...", "count": 2, "seqs": [0, 1] } ],
                   "recent": [ { "seq": 2, "child": "...", "summary": "...", "digest": "...",
                                 "characters": 42 } ] },
  "diagnostics": [ "..." ],
  "guard": {
    "settlementDedupe": true, "settlementDedupeStatus": "active", "suppressed": 1,
    "blockDeletedTargets": true, "blockDeletedTargetsStatus": "active", "blockedDeletedSends": 0
  }
}
```

要点：

- `contextPressure.level` 是**插件的梯子**，用来给 Lead 一个「该不该再唤醒它」的判断：`over` / `near_saturated` / `watch` / `ok`，测不到就是 `unknown`。等级本身不写入内核、不触发任何自动动作。阈值是 `lib/index.js` 里的 `RATIO_WATCH` / `RATIO_NEAR_SATURATED` / `RATIO_OVER` 常量；拿不到 context window 时退化为 `TOKENS_WATCH` / `TOKENS_NEAR_SATURATED` / `TOKENS_OVER` 的绝对阈值。成员若显式设了 `token_budget`，则 `min(contextWindow, tokenBudget)` 是实际预算（一个高于窗口的预算永远不会被触及，所以它不许掩盖窗口压力）。
- `capacity.used` 计的是 roster teammate 行数，**包含已退休和已删除的成员**（内核的名字与名额都不复用）；`serving` / `retired` / `deleted` / `failed` 是更细的口径。
- `children` **只列本团队自己的**非 roster 子代理（`parentSession === team.root`）：别的会话的子代理属于别的 Lead，不列进来。因此每条 `sameTeam` 恒为 `true`。
- `settlements` 按 `(child, summary, 正文 SHA-256 摘要)` 分组，报告每一组的重复次数——重复可能来自不同 Activation（合法），需要与守卫的 `suppressed` 计数一起看。
- 账本测不到时（调用方没有 live session、或日志读不出来）`settlements` **仍是同一个对象形状**，只是 `total` / `unique` 为 `0`、`repeats` / `recent` 为空数组——`0.4.0` 起不再返回 `[]`。
- `guard` 报告的是**实际装上的东西**：`settlementDedupe` / `blockDeletedTargets` 只在对应 status 为 `active` 时才为 `true`，另有 `settlementDedupeStatus` / `blockDeletedTargetsStatus` 给出 `active` / `pending` / `unsupported` / `disabled` / `failed`。
- `diagnostics` 是给人看的一句话提醒：有成员 `near_saturated` / `over` 时会点名并建议 `compact` 或换新 subagent；Team 已满时给出 `team_member_add` / `team_member_delete` / `team_capacity_set` 三条出路；存在墓碑时会点名并提示 `team_member_add` 做替代者；有 `availability: "idle-ready"` 的空闲成员时会点名并建议用 `reassign` 复用；被抑制的通知与被拦截的消息也会报计数。

### 2. `team_member_edit`

编辑一个成员：别名、改名、职责、优先级、标签、token 预算、re-brief、**reassign（改名接手下一段共享任务）**、retire/restore、compact、interrupt。`retire` / `restore` / `rename` / `reassign` 是 Lead-only；`compact` / `interrupt` 对**自己**放行、对别人 Lead-only。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target` | string | **是** | teammate durable name、conductor 别名、历史名，或 child session id。 |
| `action` | string | **是** | `alias` / `rename` / `describe` / `priority` / `tags` / `budget` / `rebrief` / `reassign` / `retire` / `restore` / `compact` / `interrupt`。 |
| `value` | string | 条件 | 新别名或新编排层名字（`alias` / `rename` / `reassign`），或新职责文本（`describe`）。名字截到 64 字符，description 截到 2000 字符。 |
| `message` | string | 条件 | 自包含简报（`rebrief` / `reassign`）。 |
| `tags` | string[] | 条件 | **整体替换**标签表（`action=tags`）；最多 32 个，每个截到 64 字符。 |
| `priority` | integer | 条件 | 越大越先跑（`action=priority`）。必须是整数。 |
| `token_budget` | integer | 条件 | 每成员上下文预算（tokens）；`0` 清除它（`action=budget`）。 |
| `task_id` | string | 否 | 要交接的共享任务（`action=reassign`）；先把该任务 reassign 给这个成员，再发简报。 |
| `compact_first` | boolean | 否 | `action=reassign` 时先压缩该成员上下文。默认 `false`。 |

```json
{ "target": "reviewer", "action": "alias", "value": "rev" }
{ "target": "rev", "action": "budget", "token_budget": 160000 }
{ "target": "rev", "action": "rebrief", "message": "新的自包含任务：复核 work/x 的 diff 并给出结论。" }
{ "target": "rev", "action": "retire" }
{ "target": "rev", "action": "rename", "value": "diff-reviewer" }
{ "target": "diff-reviewer", "action": "reassign", "value": "docs-checker",
  "task_id": "task-7", "compact_first": true,
  "message": "Next task: verify docs/ISSUES.md against lib/index.js." }
```

**任务流转（推荐做法）**：一个成员干完当前任务后，**不要**为下一段任务新建成员（内核名字永不复用、名额还占着）。先 `team_task_list` 找到下一段可领的共享任务，再用 `reassign` 一次完成「改名 + 把共享任务 reassign 给它 + 派新简报 + 清掉 retired + 用简报首行更新职责描述」。`team_overview` 会把空闲成员标成 `availability: "idle-ready"` 并在 `diagnostics` 里提示可复用。

逐 action 的准确行为：

| action | 做什么 | 边界 |
|---|---|---|
| `alias` | 写侧车 `members[<name>].alias`，此后 `target` 可用别名寻址 | 别名只在本插件的侧车与工具里有效，内核 `list_agents` 看不到。**拒绝 `lead`**（大小写不敏感）：`resolveTarget` 先匹配 Lead 伪行，这样的别名会被永久遮蔽；也拒绝与其它成员 durable name / 别名 / 历史名撞车 |
| `rename` | Lead-only；写新 `alias`，把旧名压进 `formerNames`，此后**新旧名字都能寻址** | 内核 durable name 不可改（投影拒绝 `prior.name !== member.name`，`lib/types/projection.js:196-201`）；改名只发生在编排层。**拒绝 `lead`** 与其它成员的 durable name / 别名 / 历史名；但**可以改回自己用过的旧名**（有意如此，使改名可逆） |
| `describe` | 写侧车 `description`（不改内核 roster 的 `description`） | 同上 |
| `priority` | 写侧车 `priority` | 纯记录值；内核不据此调度 |
| `tags` | 写侧车 `tags`（整体替换） | 同上 |
| `budget` | 写侧车 `tokenBudget`；`0` 清除 | 影响 `team_overview` 的饱和判定，不改内核任何行为 |
| `rebrief` | 经 team 通道给该成员投递一条 `message`，并在侧车记一条 note | 非 roster 的 child 目标走 subagent 通道 |
| `reassign` | Lead-only；改名（若给了 `value`）+ 用 `task_id` 把共享任务 reassign 给该成员（读 `getTask` 拿 revision，再 `updateTask(action="reassign")`）+ 派新简报 + 清 `retired` + 用简报首行更新 `description` + 记 note | 任务交接的结果**显式**放在返回体的 `taskHandover: { attempted, ok, reason }` 里（不再只藏在 `warnings`）：任务板不可用 / revision 过期 / 任务不可 reassign 时 `ok: false` 并给 `reason`，**简报仍会照发**——调用方必须看这个字段才知道「改名 + 认领 + 派活」是否真的三步都成了；`compact_first` 对未加载成员或服务缺失也只回 warning |
| `retire` | Lead-only；成员正在跑就先 `interrupt`，再 `roster.stopTeammates(root,[id])`（15s 超时）释放运行激活，最后写 `retired: true` + `retiredAt` | **可逆的软下线**：roster 行不会删除，名额继续被占用；`stopTeammates` 不可用时只写标记并回 warning |
| `restore` | Lead-only；把 `retired` 翻回 false | 下一条消息会 cold-resume 该成员 |
| `compact` | 对已加载成员调 `compaction.compactNow(live, signal, "dsh-team-conductor:manual")`，并在前后各测一次上下文，回报 tokens 变化 | 对别人 Lead-only、对自己放行；未加载成员只给 warning（要求先 `rebrief`）；`compactNow` 返回 `null` 表示「没有安全且有用的压缩区间」；服务在两个作用域都取不到时回 warning |
| `interrupt` | 调内核 `service.interrupt(caller, name)`，回报原状态 | 需要 roster teammate；对别人 Lead-only、对自己放行；内核自身也强制 Lead-only |

返回形状：

```
{
  "target": { "requested": "rev", "resolved": { "kind": "teammate", "id": "...",
               "coreName": "reviewer", "alias": "rev", "deleted": false, "retired": false } },
  "action": "alias",
  "member": { "target": "reviewer", "role": "teammate", "status": "inactive",
              "alias": "rev", "deleted": false } | null,
  "record": { "coreName": "reviewer", "alias": "rev", "retired": false, ... } | null,
  "effects": [ "alias resolved to \"rev\"" ],
  "warnings": [ "..." ]
}
```

`target` 解析顺序：`lead` → roster 里 durable name 精确匹配 → 侧车 alias（不区分大小写）→ live child agent id → roster 行 id → 看起来像 session id 的裸串。已被 `team_member_delete` 墓碑化的名字会**直接被拒**（`teammate "<name>" was deleted (<时间>); deletion is irreversible — create a new member with team_member_add`），不会被半寻址。都不匹配则报错并附上已知 teammate 名单。`team_message` 走同一套解析。

### 3. `team_capacity_set`

运行时改成员上限，即直接写 `teamService.roster.maxMembers`。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `max_members` | integer | **是** | 新上限，至少 1；不得低于当前已占用的名额数。 |
| `reason` | string | 否 | 随变更记入侧车 `capacity.reason`（截 200 字符）。 |

```json
{ "max_members": 24, "reason": "六问题插件工作" }
```

返回：

```json
{ "before": 8, "after": 24, "used": 1, "free": 23, "configured": 24,
  "note": "applies to this process only; the profile's configured maxMembers returns on restart" }
```

- **两处上限会被同时写：** `roster.maxMembers`（准入真正读的那个字段）与 `service.config.maxMembers`（UI/诊断读的那个）。只写前者会让 `configured` 与 `max` 永久分叉、自相矛盾，所以 0.5.0 起双写；返回体与 `team_overview.capacity.configured` 因此始终与生效值一致（`config` 不可写时为 `null`）。

- 为什么需要它：本机 desktop profile 把 `maxMembers` 配成 8（`@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:20`），内核默认值是 16（`@deepseek-ai/dsh-experimental-agent-team/lib/types/index.js:15` `DEFAULT_MAX_MEMBERS`），而内核 roster 的设计是「名字永不复用、行不可删除」。于是「满了又没有退役工具」就是死锁；提额是直接出路，`team_member_add` / `team_member_delete` 会在需要时自动各补一个名额。
- 上限判定发生在 `@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js:241-250` 的 `spawnAdmitted` 事务里：`state.members.length >= this.maxMembers` 就抛 `TEAM_MEMBER_LIMIT`（文案 `Team member limit N reached`）。`maxMembers` 是普通可写字段（同文件 `:41-45`），所以运行时可改。
- 降低上限时若低于已用名额，直接拒绝：`cannot lower the ceiling to N: M member slots are already taken (names are never reused upstream)`。它不会为了满足新上限而驱逐成员。

### 4. `team_message`

按名字/别名给 durable teammate 发消息，**或**把消息直接投递给一个非 roster 的 continuable subagent——也就是团队版 `send_message` 够不到的通道。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target` | string | **是** | teammate 名字、teammate 别名，或 child session id。 |
| `message` | string | **是** | 自包含的消息正文。 |

```json
{ "target": "reviewer", "message": "把最后的 diff 摘要发我。" }
{ "target": "abcdef01-2345-6789-abcd-ef0123456789", "message": "继续，从第 3 步接着做。" }
```

返回：

```json
{ "target": { "kind": "child", "id": "abcdef01-...", "coreName": "abcdef01-...", "alias": null,
              "deleted": false, "retired": false },
  "delivery": { "channel": "subagent", "messageId": "child-msg-1", "status": null } }
```

- teammate/lead 目标走 team 通道（`channel: "team"`，带内核返回的 `messageId` / `status`）；child 目标走 `resolveService(ctx, "subagents", caller)` 解析出的 subagent 服务（先插件 ctx、取不到再退回 `agent.ctx`）上的 `sendMessage(caller, id, content, { signal })`（`channel: "subagent"`）。
- 给自己发消息会被拒绝（`a member cannot send a message to itself`）。
- 内核 `send_message` 只解析 roster 成员：`@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js:18-27` 的 `resolveActiveMember` 对非 active 成员抛 `active teammate "<name>" not found`（`TEAM_MEMBER_NOT_FOUND`）。模型用 subagent 通道创建的子代理不在 roster 里，所以没有名字——它们的可达地址就是自己的 session id，这正是本工具补上的那一块。
- 目标串必须「看起来像 session id」才会被当作 child：只接受 8-4-4-4-12 UUID 或 `session-<数字>`，或者是当前 live agent id。随便一串都按名字/别名处理——包括纯 16+ 位十六进制这种容易被误判成 id 的形状（0.5.0 起收紧，避免全 hex 的成员名被误读成 session id）。

### 5. `team_member_add`

新建一个 durable teammate，同时把编排层的别名/优先级/标签一起记下——**满员时它自己提额**，所以不会再撞内核的 `TEAM_MEMBER_LIMIT`。Lead-only。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 唯一 lower-kebab-case 名字；内核规则是「lower-kebab-case、≤64 字符、不能叫 `lead`」（`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:702-706`），且**名字永不复用**。 |
| `description` | string | **是** | 职责简述（截到 200 字符）。 |
| `brief` | string | **是** | 完整、自包含的初始任务。 |
| `context` | string | 否 | `fresh` / `fork`；默认 `fresh`（只接受这两个值，其他值按 `fresh` 处理）。 |
| `alias` | string | 否 | 侧车别名，供 `team_message` / `team_member_edit` 使用（截到 64 字符）。 |
| `priority` | integer | 否 | 编排优先级（越大越先跑）。 |
| `tags` | string[] | 否 | 编排标签（最多 32 个，每个截到 64 字符）。 |
| `auto_capacity` | boolean | 否 | 满员时自动把上限 +1；默认 true。 |

```json
{ "name": "reviewer", "description": "复核 diff 并给出结论",
  "brief": "复核 work/x 的改动，逐条列出问题与结论。", "context": "fresh",
  "alias": "rev", "priority": 5, "tags": ["review"] }
```

行为：先数已用名额；满员且 `auto_capacity === false` 直接报错（提示先 `team_capacity_set`），否则 `raiseCeiling(+1)` 并记一条 effect；然后调内核 `service.spawnTeammate(caller, { name, description, prompt, context, provider, signal })`，`provider` 取配置的 `freshProvider`（默认 `"spawn"`）或 `forkProvider`（默认 `"fork"`）；成功后写侧车 `alias` / `priority` / `tags`、`deleted: false`、`retired: false` 与一条 note。

返回：

```json
{ "member": { "target": "reviewer", "role": "teammate", "status": "running", "context": "fresh" },
  "record": { "coreName": "reviewer", "alias": "rev", "priority": 5, "tags": ["review"], ... },
  "effects": [ "member ceiling raised 8 → 9 to make room" ],
  "warnings": [] }
```

### 6. `team_member_delete`

**硬删除一个 teammate，不可逆。** 它做四件事：中断并释放运行激活、在编排层立墓碑、拦掉所有走 Team 服务（`agentTeams.sendMessage`，内核 `send_message` 也走这条路）的投递、再把成员上限 +1 让替代者放得下。Lead-only。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `target` | string | **是** | teammate durable name 或侧车 alias（非 roster 的 child agent 会被拒：它没有 roster 记录可删）。 |
| `reason` | string | 否 | 记在墓碑上的原因（截到 200 字符）。 |
| `seal_kernel` | boolean | 否 | 是否尝试把内核 roster 记录密封成终态。默认 true；**只有成员仍在 `provisioning` 时才可能成功**（见下）。 |
| `auto_capacity` | boolean | 否 | 是否把成员上限 +1 让替代者放得下。默认 true。 |

```json
{ "target": "reviewer", "reason": "任务已交接给 reviewer-2", "seal_kernel": true, "auto_capacity": true }
```

返回：

```json
{ "deleted": { "target": "reviewer", "id": "...", "seal": "immutable-active", "upstreamRecordRemoved": false },
  "capacity": { "before": 9, "after": 10, "applied": true },
  "effects": [ "current turn interrupted", "live activation released", "conductor tombstone written",
               "upstream roster record: record is active and the upstream projection forbids rewriting it (only provisioning -> active|failed is legal); it stays listed upstream, so the tombstone and the message guard are what make the deletion effective",
               "member ceiling raised 9 → 10 so a replacement fits" ],
  "warnings": [],
  "note": "irreversible and *conductor-level*: ... the ceiling was raised so a replacement fits" }
```

`seal` 的取值：`sealed-provisioning`（成员还在 `provisioning`，追加了唯一合法的终态边 `provisioning → failed`）/ `immutable-active`（成员已 `active`，**不会写任何日志**）/ `immutable-failed` / `skipped`（`seal_kernel: false`）/ `not-in-roster` / `journal-unavailable`。

**为什么「删除」要长成这样。** 内核 roster 是**只能追加的持久日志**，而且**投影本身**只允许一次迁移：`@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.js:196-203` 对已有记录要求 `prior.phase === "provisioning"` 且新相位非 `provisioning`，同时禁止改 `name` / `provider` / `context`（`changed immutable identity fields`）。所以：

- 已经 `active` 的成员**无法被改写、也无法被移除**；
- 硬删只能表达成 **编排层墓碑 + 消息拦截 + 自动补 1 个名额**；
- 对 `provisioning` 成员则可以写合法的 `provisioning → failed`（`TeamRoster.settleProvisioning` 在非 provisioning 时会提前返回，因此不会与我们竞争出非法追加）。

**不可逆语义：** 墓碑写进侧车后，这个名字在所有编排层入口（`team_member_edit` / `team_message` / `team_member_delete` 的 target 解析）都被直接拒绝并提示 `team_member_add`；`team_overview` 会继续把它列在 `members` 里（`deleted: true` / `deletedAt`）并计入 `capacity.used` 与 `capacity.deleted`，因为它仍占着内核的一行。`retire` 才是可逆的软下线。

**消息拦截（`blockDeletedTargets`，默认开启）：** 插件在 `agentTeams.sendMessage` 上装了一层包装，对墓碑成员的投递直接抛 `teammate "<name>" was deleted by dsh-team-conductor (<时间>); the message was not delivered`。这样即使内核 roster 里那行还在、内核工具仍认得这个名字，实际也发不出去。被拦次数在状态路由的 `blockedDeletedSends` 与 `team_overview.guard.blockedDeletedSends` 里可查。

**覆盖面（0.5.0 起已完整）：** 已删成员在**所有**通路上都不可达，由三层共同保证：

1. **Team 服务层**——本守卫包装 `agentTeams.sendMessage`，内核 `send_message` 也走这条路；
2. **target 解析层**——名字 / 别名 / 历史名 / durable id 一律在 `resolveTarget` 里拒绝，并且 roster-id 查询**排在 live-agent 快捷路径之前**（否则一个还没释放完、仍 resident 的已删成员会被解析成裸 `child`，绕过第一层）；
3. **child 通道层**——`deliver()` 的 child 分支进门前用 `deletedMemberById()` 按 id 复查墓碑，再交给 `subagents.sendMessage`。

非 roster 子代理没有侧车记录，所以这三层都不会误伤它们。

它同样会用 owner 重校验保持诚实（fiber 换实例后重装），状态与作用域在状态路由的 `deleteGuard` / `deleteGuardScope` 里：`active` / `pending`（`agentTeams` 服务还没出现）/ `unsupported`（服务上没有 `sendMessage`）/ `disabled` / `failed` / `removed`。

---

## 侧车状态

插件把内核 roster 不承载的信息（别名、职责、优先级、标签、预算、退休与删除标记、备注、容量变更记录）写进侧车文件，每个 Team root 一份：

```
$DSH_HOME/dsh-team-conductor/teams/<rootSessionId>.json
```

`$DSH_HOME` 未设置时用 `~/.dsh`（`dshHome()` 处理 `~`、`~/...` 与普通路径）；文件名把 root id 中非 `[a-zA-Z0-9._-]` 的字符替换成 `_`，截到 200 字符。

写入是**原子**的：先写 `<file>.tmp`，再 `rename` 覆盖（`writeStore()`）；读取容忍文件缺失或损坏——解析失败即当作空 store，不抛错。读路径还有一层按 `mtimeMs + size` 校验的**进程内缓存**（`blockedTarget()` / `resolveTarget()` 每次寻址都要读侧车，缓存把每条消息的同步磁盘读去掉）：缓存值按不可变处理，每次 `writeStore()` 都会刷新它，所以外部编辑器和本插件自己的写入都不会读到旧值。

形状：

```json
{
  "version": 1,
  "rootId": "<root session id>",
  "updatedAt": 1761000000000,
  "members": {
    "reviewer": {
      "coreName": "reviewer",
      "alias": "rev",
      "description": "owns the diff review",
      "priority": 5,
      "tags": ["review", "diff"],
      "tokenBudget": 160000,
      "retired": true,
      "retiredAt": "2026-10-24T02:14:56.000Z",
      "deleted": true,
      "deletedAt": "2026-10-24T03:02:11.000Z",
      "deleteReason": "任务已交接给 reviewer-2",
      "notes": ["added 2026-10-24T02:10:03.000Z", "re-briefed 2026-10-24T02:20:11.000Z"]
    }
  },
  "capacity": { "observedMax": 24, "reason": "六问题插件工作", "changedAt": "2026-10-24T02:21:03.000Z" },
  "stats": {}
}
```

- `members` 以 **durable name** 为键（不是别名）；`notes` 只保留最近 10 条。
- `deleted` 只在 `team_member_delete` 之后为 true；`retired` 由 `action=retire/restore` 翻转。
- `capacity.observedMax` 记的是本进程最后一次改动后的上限（`team_capacity_set` 与 add/delete 的自动提额共用这一字段）。
- `stats` 在默认空 store 中存在，但当前实现不写入它（保留字段）。
- 侧车是按 root 隔离的：`lead-1` 的 `members.reviewer.alias` 与另一个 root 的同名成员互不影响。
- 交付给模型的输出里没有侧车路径；路径只出现在状态路由的 `store` 字段与日志里。

---

## 结算通知守卫

### 它做什么

结算通知的**真实**入口是 `ctx.subagents.continuations.activations.notifySettlement(activation, terminal)`——注意它**不在 `ctx.subagents` 服务对象上**：方法定义在 `ContinuableActivationRegistry`（`@deepseek-ai/dsh-subagent/lib/index.js:1254`，唯一内部调用点 `:1248`），而 `SubagentRuntime.continuations` 是服务字段（`:2826/:2842`），其 `activations` 又是该 manager 的字段（`:1662`）。插件沿 `subagents.continuations?.activations` → `subagents.activations` 找到宿主对象，就地替换成一个受 `WeakSet` 保护的包装：

- 第一次见到某个 **Activation 对象**（引用身份）→ 原样调用 `original.apply(this, [activation, terminal])`。
- 第二次见到**同一个对象** → 直接返回 `undefined`，并把 `state.stats.suppressedNotices` 加一。

计数会出现在两处：`team_overview` 的 `guard.suppressed` 与 `diagnostics`，以及状态路由的 `suppressedNotices`。

### 两个实现陷阱（都踩过）

1. **包错对象 = 静默失效。** 服务对象上没有 `notifySettlement`，所以包装 `subagents.notifySettlement` 在真实内核上永远 `unsupported`，而 `guard.settlementDedupe` 还显示 `true`——看起来在工作，实际一次都没生效。现在 `guard.settlementDedupe` 只在状态为 `active` 时才为 `true`，并附 `settlementDedupeStatus`。
2. **`ctx.get()` 返回的是 cordis Proxy。** `Object.defineProperty` 能落到真实实例（没有 trap），但**函数值读回会被 Proxy 再包一层**，所以 `readback !== wrapper` 永远成立 → 误判 `failed`、`state.guard` 不设置、每次工具调用再包一层（泄漏且无法还原）。现在的判据是 `Object.getOwnPropertyDescriptor(owner, name).value === wrapper`，幂等靠包装函数上的 `__dshTeamConductorGuard` 标记属性（Proxy 的 `get` 能读到该属性），完全不依赖引用相等。

### 为什么只抑制同一个 Activation 的第二次通知

结算通知的 durable source 只有四个字段：

```js
// @deepseek-ai/dsh-subagent/lib/types/continuation-messages.js:98-103
source: { kind: 'subagent-settled', form: 'notice', summary: '<摘要行>', senderSessionId: childId }
```

里面**没有 activation 标识、也没有 settlement id**（生成函数是 `createSettlementMessage(childId, terminal)`，同文件 `:85-105`）。所以「同一个 Activation 被通知两次」和「两个不同 Activation 各自结束、正文恰好相同」在内容上完全无法区分。唯一无歧义的信号就是 Activation 对象本身：

- 同一个 Activation 对象被通知两次 → 按定义就是重复投递，抑制。
- 两个不同 Activation 各产一次通知 → 即使正文一字不差，也**各自照常投递，一次不少**。

因此守卫**不会吞掉合法通知**：它按对象身份去重，不按内容哈希去重。

### 装载时机与状态

`subagents` 服务在 shipped profile 里可能**晚于本插件绑定**，所以安装是幂等的、并且会被反复驱动：`apply()` 时一次、`internal/service` 绑定钩子收到 `subagents` 时一次（这与 `dsh-agent-preset-registry` 用的是同一个接缝）、以及**每次工具调用**前一次（`ensureGuard()`）。状态可从状态路由的 `settlementGuard` 读到：

| 值 | 含义 |
|---|---|
| `active` | 已在激活注册表上安装成功（descriptor 判据通过，且宿主对象就是当前的那一个）。 |
| `pending` | `subagents` 服务还没出现，或服务已出现但它的 `continuations` 还没绑定（内核在 inject 回调里赋值）——这是**瞬态**，会在绑定钩子与每次工具调用时重试。 |
| `unsupported` | `continuations` 已存在，但 `continuations.activations`（及回退的 `subagents.activations`）上都没有 `notifySettlement`——说明内核版本变了、没有这个接缝。 |
| `disabled` | 配置 `dedupeSettlementNotices: false`。 |
| `failed` | 替换抛错，或 descriptor 判据不成立（记一条 warn 日志）。 |
| `removed` | 插件 disposal 后已还原（仅用于内部状态）。 |

装上之后仍会**重新校验宿主**：判据是 `state.guard.owner === 当前激活注册表实例 && isOurWrapper(...)`。fiber 重载会换出全新的注册表实例，把守卫留在旧实例上会永远 self-report `active` 却再也不触发；重校验不通过就丢掉旧记录并重装。

插件的 disposal 路径会把方法还原成 `original`——仅当当前值仍是自己的包装时才还原，避免覆盖别人后装的实现。守卫是进程内 `WeakSet`：重启不保留，跨进程也不共享。

### 如何关闭

```json
{ "dedupeSettlementNotices": false }
```

（bundle 配置，即 `dsh plugin ... add` 时或 profile patch 中该行的 `config`。）关闭后 `guardStatus` 为 `"disabled"`，`notifySettlement` 保持内核原样。

---

## 配置

插件读取的 bundle 配置项（未知键会被忽略并记一条 warn 日志）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dedupeSettlementNotices` | boolean | `true` | 是否安装结算通知守卫；`false` 关闭。 |
| `blockDeletedTargets` | boolean | `true` | 是否拦截发往墓碑成员的消息（包装 `agentTeams.sendMessage`）。 |
| `defaultContextWindow` | number | 无 | 路由模型信息不可用时的兜底 context window。 |
| `maxOverviewNotices` | integer | `10` | `team_overview` 的 `settlements.recent` 保留多少条；被夹到 1–50。 |
| `freshProvider` | string | `"spawn"` | `team_member_add` 在 `context=fresh` 时用的 subagent provider。 |
| `forkProvider` | string | `"fork"` | `team_member_add` 在 `context=fork` 时用的 subagent provider。 |
| `verboseLogging` | boolean | `false` | 为 `true` 时每次工具调用打一行 info 日志（工具名、调用者 id、参数前 300 字符）。 |

### 覆盖配置（profile patch 层）

配置走 profile 的用户覆盖层即可，不必改 bundle：在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加

```yaml
- id: team-conductor
  name: dsh-team-conductor
  config:
    dedupeSettlementNotices: true
    blockDeletedTargets: true
    maxOverviewNotices: 12
```

覆盖层在 bundle 之后应用、`config` 整体替换（同 id 后应用者胜）。**实测：改这个文件会立刻热重组**（`cordis.yml` 里该行的 `config` 马上跟着变——`dsh-hmr` 用 chokidar 监听 profile patch 文件），所以**配置项是热生效的**。

**但插件代码不是。** 同一个 id 的模块 specifier 不变，ESM 缓存就仍然命中首次 import 的那一版——改 `lib/index.js` 后进程会一直服务旧代码，必须重启 Harness。这两件事别混为一谈（实测过：config 已进 `cordis.yml`，状态路由仍自报旧版本）。

---

## 验证

```bash
cd work/dsh-team-conductor
node --check lib/index.js          # 语法/加载面
node tests/smoke.mjs              # 行为套件：逐条打印 PASS/FAIL，有失败则退出码非 0
curl -i http://127.0.0.1:19387/dsh-team-conductor/status
node scripts/verify-live.mjs      # 断言**运行中的进程**确实是这一版（重启后跑这个）
```

> **改完代码必须重启 Harness。** 宿主插件的模块被 ESM loader 缓存，磁盘上的新代码不会热生效——运行中的进程会一直服务它首次 import 的那一版。`scripts/verify-live.mjs` 就是用来区分「磁盘上是 0.5.0」和「进程里真的是 0.5.0」的：版本号、六个工具、两个守卫状态逐项断言，不一致时退出码非 0 并直接提示重启。

`tests/smoke.mjs` 自带伪造的 cordis 上下文与宿主服务（`subagents` 用 **Proxy** 包裹、`notifySettlement` 挂在 `continuations.activations` 上，形状照内核源码），**共 62 项**，覆盖：插件导出面、六个工具的 schema 是否落在 `tools.register()` 的受支持子集内、注册契约（`output { schema, render }`）、守卫落点与幂等（含 Proxy 回读陷阱与 owner 重校验）、**冷启动下 `webServer` 晚绑定后状态路由经钩子补注册**、`team_overview` 的测量/容量/账本/子代理过滤/`availability`/`include_pressure` 跳过路径、`team_member_edit` 全部 12 个 action 与参数拒绝（含 rename 冲突与可回退旧名、`lead` 保留名拒绝、reassign 的 `taskHandover` 两种结局）、`team_capacity_set` 的双写与两条拒绝路径、`team_message` 的两条投递通道、删除后按名字与**按 id** 的双重拦截、目标解析（含历史名与 id 形状收紧）、饱和梯子、账本分组与缓存、侧车往返/缓存失效/按 root 隔离、detached header 完整性、状态路由。**以实际输出为准**：套件会逐条报告，失败项不会伪装成通过。

状态路由（`GET`/`HEAD`，其余方法 405；非回环来源 403）返回：

```json
{ "ok": true, "plugin": "dsh-team-conductor", "version": "0.5.0",
  "teamService": true,
  "tools": ["team_overview", "team_member_edit", "team_capacity_set", "team_message",
            "team_member_add", "team_member_delete"],
  "installedAgents": 1,
  "settlementGuard": "active", "settlementGuardScope": "subagents.continuations.activations",
  "suppressedNotices": 1,
  "deleteGuard": "active", "deleteGuardScope": "plugin", "blockedDeletedSends": 0,
  "statusRoute": "active", "clientHalf": "absent",
  "installFailures": 0, "store": "C:/Users/.../.dsh/dsh-team-conductor/teams" }
```

**路由也走"惰性重试"这条梯子**（和两个守卫同一套机制）：`webServer` 在冷启动时可能**晚于本插件绑定**，而 `apply()` 只跑一次——早期实现因此在冷启动后让这个端点永远 404（热重载时反而正常，因为那时 `webServer` 已就位）。现在注册是幂等的，并在 `internal/service` 收到 `webServer` 与每次工具调用时重驱动；`statusRoute` 字段报告它自己的状态（`active` / `pending` / `failed`）。

回环门禁：带 `sec-fetch-site` 时只拒绝 `cross-site`；带 `origin` 时 hostname 必须是 `127.0.0.1` / `localhost` / `[::1]` / `::1`；两个头都没有（例如普通 `curl`）则放行。

---

## 六个问题：本插件怎么处理

每条给出「现象 / 根因坐标 / 本插件处理 / 边界与残留风险」。更细的坐标、函数名与需要上游做的事见 [docs/ISSUES.md](docs/ISSUES.md)。

### 1. 队友上下文饱和后无法完成最小闭环；饱和状态对 Lead 不可见；续用开销随轮次线性增长

- **现象：** 队友接近或超过上下文窗口后，再次唤醒往往产不出可用结果；Lead 看不到「谁已经满了」，于是按惯性反复唤醒；每次唤醒都要重放整段历史，成本逐轮线性增长。
- **根因坐标：** 内核 roster 视图没有 token 维度。`@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:35-79` 的 `MEMBER_VIEW_SCHEMA` / `modelMember` 只暴露 target/role/status/description/provider/context/model/diagnostics，`:323-330` 的 `list_agents` 直接映射 `listAgents()`；`@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js:104-135` 的 `list()` 同样没有任何占用字段。测量与压缩能力其实都在：`@deepseek-ai/dsh-token-meter/lib/index.js:641-695` 的 `measure(session)`（`totalTokens` 在 `:680`）、`@deepseek-ai/dsh-compaction-basic/lib/index.js:985` 的 `compactNow(agent, signal, sourceCommandId)`；窗口来自 `@deepseek-ai/dsh-llm/lib/index.js:2098-2100` 的 `resolveModelInfo`（返回体 `context.contextWindow` 在 `:2124`）。
- **本插件处理：** `team_overview` 给每条 roster 行附 `contextPressure`（tokens / contextWindow / tokenBudget / ratio / remaining / level / known / source）；未加载的成员用持久化日志造一个分离副本再测量，所以 Lead 能在**唤醒之前**看到冷成员已经多满；`team_member_edit action=compact` 调内核压缩并在前后各测一次，把 tokens 变化回报给 Lead；`watch` / `near_saturated` / `over` 的成员会在 `diagnostics` 里被点名并给出「compact 或换新 subagent」的建议。
- **边界与残留风险：** 测量需要 `tokenMeter`、`llm`、`sessions`、`sessionPersistence` 都在位；缺任一即 `known: false` + `detail`，**绝不估算**。级别只是插件的梯子，不写回内核、不触发自动动作；未加载成员超过 40000 事件或读不到就放弃测量（`source: unreadable`）。`compact` 只对已加载成员生效，未加载成员必须先 `rebrief` 唤醒。

### 2. `spawn_teammate` 上限 8，且没有退役/删除工具 → 死锁

- **现象：** Team 满了以后 `spawn_teammate` 只会返回 `TEAM_MEMBER_LIMIT`；没有任何工具能删掉一个不再需要的成员，于是团队永久卡死。
- **根因坐标：** 8 不是内核默认值，而是本机 profile 的配置——`@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:20` 的 `maxMembers: 8`；内核默认 16（`@deepseek-ai/dsh-experimental-agent-team/lib/types/index.js:15` `DEFAULT_MAX_MEMBERS`）。判定在 `@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js:241-250` 的 `spawnAdmitted` 事务内（`state.members.length >= this.maxMembers` → `TEAM_MEMBER_LIMIT`），而 `this.maxMembers` 是普通可写字段（同文件 `:41-45`）。内核 roster 的设计就是「扁平且不可变：不支持嵌套 Team、重命名、删除或名字复用」（`@deepseek-ai/dsh-experimental-agent-team/README.zh.md:208`），名字占用判定在 `roster.js:243-245`（`TEAM_MEMBER_NAME_TAKEN`）。可用的释放路径是 `roster.js:218-220` 的 `stopTeammates(root, childIds)` → `ctx.subagents.drainContinuableChildren`；成员能经历的终态迁移只有 `provisioning → active|failed` 一次（`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1292-1308`）。
- **本插件处理：** `team_capacity_set` 在运行时直接写 `teamService.roster.maxMembers`（不重新装载、不重启），并拒绝把上限降到已用名额以下；`team_member_add` 满员时自己提额 +1，所以不会再撞 `TEAM_MEMBER_LIMIT`；`team_member_delete` 用「编排层墓碑 + 消息拦截 + 自动补 1 个名额」表达删除，让「删掉再新建」真的可行；**已完成任务的成员还可以 `team_member_edit action=reassign` 改名接手下一段共享任务，连新名额都不用花**；`team_member_edit action=retire` 是可逆软下线：先 interrupt（若在跑）再 `stopTeammates(root,[id])` 释放运行激活，最后写退休标记。
- **边界与残留风险：** **容量改动只在当前进程生效，重启回到 profile 配的 8。** **内核 roster 日志无法忘记记录**：墓碑不能把一行从 `state.members` 里拿掉，名字仍不可复用，`used` 仍包含它——补 1 个名额是唯一让替代者进来的办法。密封受内核迁移规则限制：只有 `provisioning` 成员能被写成 `failed`；已经 `active` 的成员返回 `immutable-active` 且**不写任何日志**（写就是非法转换，会污染投影），此时只有墓碑、消息拦截与补名额起作用。

### 3. subagent 与 `spawn_teammate` 的定位差异无文档；subagent 创建后无法被 `send_message` 寻址

- **现象：** 模型创建了一个 subagent，之后想给它补一条指令却找不到名字：`send_message` 报 `active teammate "<name>" not found`；`list_agents` 里也看不到它。
- **根因坐标：** team profile 把全局 child 控制工具整排 `disabled: true`——`@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml:4-14` 关掉了 `tool-subagent`、`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent-fork`，改由 team-scoped 工具替代。而 team 版 `send_message`（`@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js:295-320`）经 `agentTeams.sendMessage`（`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1773-1775`）→ `TeamMailbox.send`（`.../lib/types/mailbox.js:97-107`）→ `resolveActiveMember`（`.../lib/types/roster.js:18-27`），**只解析 roster 成员**，非 active 直接抛 `TEAM_MEMBER_NOT_FOUND`；`list_agents`（tool-agent-team `:323-330`）同样只映射 roster。模型建的 subagent 不在 roster，因此没有可用名字。真正可达的通道是 `ctx.subagents.sendMessage(sender, targetId, content, options)`（`@deepseek-ai/dsh-subagent/lib/index.js:1762-1775`）→ `deliverToChild`（`:1808-1818`）→ 无 live Activation 时 `coldResume`（`:1898`）。
- **本插件处理：** `team_message` 的 `target` 接受 roster 名字、侧车别名，**也接受 child session id**——后者直接走 subagent 服务，从而能中途 steer 非 roster 的 continuable subagent；`team_overview` 的 `children` 字段把**本团队**的这些子代理连同 id、父会话、是否同 Team 一起列出来，让 Lead 有东西可寻址。
- **边界与残留风险：** child 投递要求调用方是「精确 live sender agent」（`@deepseek-ai/dsh-subagent/lib/index.js:1763` 的 `UNAUTHORIZED`）；`target` 只支持 live agent id 或**形状**像 session id 的串，任意名字不会被当 id 处理；中途 steer 依赖持久化日志能重建 child（`coldResume` 会重建并提交等待中的轮次）；`children` 只列本团队的会话，别的 Lead 的子代理不会混进来。定位差异仍然只能靠这段文档与注入的 policy 说明，内核侧没有统一解释。

### 4. 同一份 teammate 完成通知（closing message）重复投递

- **现象：** 同一次子代理结束，parent 会话里出现两条内容相同的结算通知，模型把它当成「又完成了一轮」。
- **根因坐标：** 通知由 `@deepseek-ai/dsh-subagent/lib/types/continuation-messages.js:85-105` 的 `createSettlementMessage(childId, terminal)` 生成，source 只有 `{kind, form, summary, senderSessionId}`（`:98-103`），**没有 Activation 标识**；投递点是 `@deepseek-ai/dsh-subagent/lib/index.js:1208-1252` 的 `finishDisposal`（`:1248` 调 `notifySettlement`），再由 `:1254-1268` 的 `notifySettlement` 走 `sendWaking`/`inject`。于是「同一 Activation 被通知两次」与「两个不同 Activation 产出相同结尾」在内容上不可区分。
- **本插件处理：** 结算通知守卫按 **Activation 对象身份**（`WeakSet`）去重：同一个对象第二次被通知时直接抑制并计数；两个不同 Activation 各产一次时**一次不少地放行**，即使正文完全一致。守卫装在**真正的宿主对象**上——`subagents.continuations.activations`（激活注册表），而不是 `subagents` 服务本身；安装是幂等的，并在 `internal/service` 绑定钩子与每次工具调用时重驱动，因此服务晚于插件绑定也能装上。`team_overview` 另外把本会话日志里的通知按 `(child, summary, 正文摘要)` 分组，报告重复次数，供 Lead 与 `guard.suppressed` 对照。
- **边界与残留风险：** 守卫是进程内 `WeakSet`，不跨进程、不跨重启；它改造的是激活注册表上的方法（`Object.defineProperty`，writable/configurable，enumerable false），成功判据是 descriptor 而非引用相等（Proxy 回读会把函数再包一层，用 `!==` 判会永远误判失败）；服务缺席报 `pending`、找不到 `continuations.activations` 报 `unsupported`、descriptor 不成立报 `failed`，都不静默。两个**不同进程**重复投递同一 Activation 的场景守卫无法覆盖。上游的正解是给通知 source 加 activation/settlement 标识，或让 `notifySettlement` 自身按 activation 幂等。

### 5. `edit` 报「read 状态过期」时缺少可执行的恢复指引，整轮零产出

- **现象：** 编辑工具报 `FS_STALE_VERSION` / `FS_NOT_OBSERVED` 后，队友放弃整轮，什么都不产出。
- **根因坐标：** 拒绝侧在 `@deepseek-ai/dsh-fs-observation-policy/lib/index.js`（`editIntent` 对未观测目标抛 `FS_NOT_OBSERVED`，版本 CAS 由提供方执行）；模型可见文案在 `@deepseek-ai/dsh-tool-fs/lib/index.js` 的 `remediateFsError()`：`FS_NOT_OBSERVED` 规范化为 `cannot modify "<path>": file has not been read — read the file, then retry`，`FS_STALE_VERSION` 保留提供方原因并追加 `— re-read the file, then retry`。也就是说文案**止于「重新读一下再试」**，没有「怎么把这次编辑重新施加」的可执行步骤（唯一字符串替换、不要按行号、不要因此丢掉整轮）；`@deepseek-ai/dsh-fs-observation-policy/README.zh.md` 还说明观察状态不持久化、恢复的会话必须重新读目标。
- **本插件处理：** 注入的 policy 段（section `team:conductor:policy`，order 640，紧跟内核 `TEAM_POLICY = 600`）给出完整恢复序列：先用 `read` 刷新观察状态，再用唯一字符串做替换、不要用行号，一次一处、改完立刻自检，并且**不要放弃本轮**。
- **边界与残留风险：** 这是提示层修复，不能阻止一个不读 policy 的模型继续放弃；内核错误文案里的「re-read, then retry」仍在，两层指引并存时以内核文案为先出现，模型需要读完 policy 才知道接下来的两步。

### 6. 队友倾向写外部补丁脚本（`fix3.py`/`fix4.py`、shell heredoc）打补丁，语法错时静默失败

- **现象：** 改一个上千行的文件时，队友生成一次性补丁脚本或 heredoc，脚本因引号/语法问题失败，文件其实没变，但输出看起来「已经改过了」。
- **根因坐标：** 没有单点内核缺陷。文件系统工具的模型可见文案只约束「读后写」——`@deepseek-ai/dsh-tool-fs/lib/index.js` 的 `write`/`edit` 通过 `fs/*` 意图槽位取版本防护，`remediateFsError()` 只处理观测/版本错误——**不约束用哪种方式写**；heredoc 与外部脚本经 `@deepseek-ai/dsh-tool-bash` 执行，脚本自身语法错误与「产物是否真的改变」没有任何校验。在 build 的 prompt / policy / 文档文本中检索 `heredoc`、补丁脚本相关字样**没有任何命中的禁令**，即内核侧目前不存在这条纪律文本。这一条的「应在哪一层补」属于上游选择：**需上游确认**（候选位置是 `@deepseek-ai/dsh-tool-bash` 的模型可见文案或内核 `TEAM_POLICY` 段）。依据：上述检索在 `app.asar` 的 `dsh/node_modules/@deepseek-ai/**` 文本层无命中。
- **本插件处理：** 注入的 policy 段明确要求用编辑工具就地改：先 `read` 刷新观察状态，再用唯一字符串替换、一次一处、改完立刻自检；**禁止**生成外部补丁脚本，**禁止**用 heredoc 打补丁，并点明失败模式（引号/语法问题 → 静默失败 → 看起来改过其实没变）。
- **边界与残留风险：** 同上，纯提示层约束，对不遵守的模型没有强制力；工具层并不阻止这类操作成功执行。

---

## 兼容性

- **插件版本：** 本文档对齐 `0.5.0`（`package.json` 的 `version` 与 `lib/index.js` 的 `PLUGIN_VERSION` 一致；状态路由自报同一版本号）。
- **内核版本：** 面向 DeepSeek Harness `0.2.0-rc.2`（逐个核对 `@deepseek-ai/dsh-tools`、`dsh-subagent`、`dsh-token-meter`、`dsh-compaction-basic`、`dsh-llm`、`dsh-experimental-agent-team`、`dsh-experimental-tool-agent-team`、`dsh-system-prompt` 的 `package.json` `version` 均为 `0.2.0-rc.2`）。本文档的所有内核坐标都取自该版本。
- **不 import 任何 `@deepseek-ai/*` 包：** profile 插件位于 `app.asar` 之外，从 profile 目录 import harness 包会以 `ERR_MODULE_NOT_FOUND` 失败（每个随包发布的 profile 插件都是自带依赖或完全不依赖）。因此本插件只 import Node 内建模块，能力全部经 `ctx.get()` 拿服务（`agentTeams`、`subagents`、`tokenMeter`、`compaction`、`sessions`、`sessionPersistence`、`llm`、`webServer` 都是惰性获取，缺了就降级而不是崩），工具定义按 `tools.register()` 接受的 JSON Schema 子集手写，注册契约要求 `output { schema, render }` 也手写满足。
- **声明的必需服务：** `inject = ["agents", "tools", "systemPrompt"]`；其余服务全是可选。`agentTeams` 缺席时，插件仍装载，只有顶层 root 会被当作 workplace，容量/roster/team 消息相关能力报告为不可用。
- **Node：** `>= 20`（`package.json` `engines`）。
- **平台：** `win32` / `darwin` / `linux`。

## 已知限制

1. **容量改动只在当前进程生效。** `team_capacity_set` 与 add/delete 的自动提额都直接写 `teamService.roster.maxMembers`；重启后回到 profile 配置的值（本机 desktop profile 为 8），侧车里的 `capacity.observedMax` 只作记录。
2. **内核 roster 行无法真正删除。** `team_member_delete` 是「墓碑 + 消息拦截 + 补 1 个名额」，行仍在 `state.members` 里、名字仍不可复用、`capacity.used` 仍包含它；`retire` 则是可逆软下线（标记 + 释放运行激活）。更多名额归根结底只有提额一条路。**完成任务的成员应优先 `reassign` 复用，而不是删掉再建。**
3. **密封只在 `provisioning` 时可能。** 内核投影只允许 `provisioning → active|failed` 这一次迁移（`@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.js:196-203`）；对一个已经 `active` 的成员，`seal_kernel` 返回 `immutable-active` 并且**不会写日志**——写下去就是非法转换，会让之后每一次 `journal.state()` 读取都抛错、把整支 Team 的编排面弄坏。此时只有墓碑、消息拦截与补名额起作用。
4. **侧车信息对内核不可见。** alias/formerNames/description/priority/tags/budget/retired/deleted 全在侧车；内核 `list_agents` 与 roster 视图看不到它们，其他工具也不认识别名（只有本插件的工具解析别名与历史名）。
5. **测量依赖多个服务。** `tokenMeter`、`llm`、`sessions`、`sessionPersistence` 缺任一，`contextPressure.known` 为 false、级别 `unknown`，只有 `detail` 说明原因——不猜、不估算。
6. **未加载成员的测量是分离副本。** 用 `sessions.prepare(id, { ..., eventState: "detached" })` 造一个从未进入的副本再测量；读不到或事件数 > 40000 就放弃（`source: unreadable` / `unloaded`）。这个副本只用于测量，不会被驱动执行。副本的 header 从**持久 header 透传**：`version` 不再硬编码 4（内核升到新会话格式时不会整片降级为 `unknown`），`createdAt` 要求非负安全整数、否则回退 `Date.now()`，`id`/`isSeeded` 显式给出——这几个字段是 `Session.fromRestore` 的硬校验项，缺一个就整段测量失效。
7. **`compact` 需要成员已加载。** 未加载成员只得到一条 warning（要求先 `rebrief` 唤醒）；`compactNow` 返回 `null` 表示没有安全且有用的压缩区间；`compaction` 服务在两个作用域都取不到时也只回 warning。
8. **两个守卫都是进程内包装。** 结算守卫按 Activation 对象身份去重（`WeakSet`），删除守卫按侧车墓碑判定；都不覆盖跨进程，重启即恢复内核原样。关闭方式：`dedupeSettlementNotices: false` / `blockDeletedTargets: false`。
9. **守卫状态必须看 `active`。** `team_overview.guard.settlementDedupe` / `blockDeletedTargets` 只在对应 status 为 `active` 时才为 true；`pending` 表示服务还没绑上，`unsupported` 表示找不到 `subagents.continuations?.activations`（说明内核版本变了）。
10. **`rename` / `reassign` 只改编排层。** 内核 durable name 与 `provider`/`context` 都是不可变身份字段（`projection.js:196-201`），所以改名不会改变内核视图；旧名字通过 `formerNames` 继续可寻址。
11. **工具只在 Team 成员的 agent scope 注册。** 非成员 agent 看不到六个工具；成员身份不足以判定时（降级模式）只有顶层 root 会被当作 workplace。

## 两个委派引擎（`delegationEngine`）

插件有两种底层，工具面完全相同，切换只改一个配置：

| | `kernel`（默认） | `conductor` |
|---|---|---|
| 成员是什么 | 内核 Agent Teams 的 roster 条目 | 本插件用 `subagents.startContinuable` 起的可续接子代理 |
| 名册在哪 | 内核 roster（**只增不删**，名字永不复用） | 插件侧车 `teams/<root>.json`（**随便改**） |
| 删除一个成员 | 立墓碑 + 拦消息 + **上限 +1 补偿**（名额永久被占） | drain 子代理，**名额还给池**；记录归档，**名字可复用** |
| 容量上限 | `roster.maxMembers`（desktop 8 / 内核 16） | `maxActiveSubagents`（`dsh-subagent` 的配置，默认 8，**会回收**） |
| 需要内核 Team 包吗 | 需要 | **不需要** |

```yaml
- id: team-conductor
  config:
    delegationEngine: conductor
```

**为什么这一步值得**：内核 roster 是追加日志，`state.members.length >= maxMembers` 数的是**行数**，而 `stopTeammates` 只停会话不删行——删掉的成员永久占位。conductor 引擎改用 `subagents` 的池：实验验证过，把 `maxActiveSubagents` 设成 1 时第二个创建被拒（`ACTIVATION_LIMIT_REACHED`），drain 之后第三个成功，**名额真的回来了**。

**启用 conductor 时同步关掉内核那层**（否则两套名册打架）：

```yaml
- id: agent-team
  disabled: true
- id: tool-agent-team
  disabled: true
- id: ui-agent-team      # 面板用我们自己的页头按钮
  disabled: true
```

**注意**：切换引擎后名册从空开始——旧的 kernel 成员不再属于任何团队（它们的会话仍在，但 roster 已关）。用 `team_member_add` 重建即可。

## English summary

`dsh-team-conductor` is a DeepSeek Harness profile bundle that adds an Agent Teams control plane on top of the kernel team tools. It registers six new tools — `team_overview` (roster plus per-member context pressure, capacity and the settlement-notice ledger), `team_member_edit` (alias/rename/describe/priority/tags/budget/rebrief/reassign/retire/restore/compact/interrupt), `team_capacity_set` (runtime member ceiling), `team_message` (deliver by name, alias, former name or child session id), `team_member_add` (create a teammate, raising the ceiling itself when full) and `team_member_delete` (irreversible: tombstone, block messages to the name, and add one slot) — injects a `team:conductor:policy` prompt section at order 640, and installs two additive guards: a settlement-notice guard on `subagents.continuations.activations.notifySettlement` that suppresses only a second notice for the same Activation object, and a deleted-target guard on `agentTeams.sendMessage`. `reassign` is the recommended flow for reusing a finished member: rename it, hand it the next shared task and brief it in one call. It imports no `@deepseek-ai/*` package, keeps its own per-root sidecar at `$DSH_HOME/dsh-team-conductor/teams/<rootSessionId>.json`, and exposes a loopback-only status route at `/dsh-team-conductor/status`. Built and verified against kernel `0.2.0-rc.2`; MIT licensed.