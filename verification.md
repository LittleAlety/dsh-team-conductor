# dsh-team-conductor 独立验证报告（verification.md）

- 验证人：plugin-verifier（独立于作者；默认立场怀疑）
- 报告对象：`work/dsh-team-conductor`（DSH cordis 插件 bundle）
- **本报告只对下列 sha256 负责**；作者在本任务期间共改了 5 版（1394→1708→1986→2023→2033 行），此前任何一版的结论均作废。
- 报告性质：**只读验证**。我全程未修改 `lib/index.js` / `tests/smoke.mjs` / `package.json` / `cordis.patch.yml`，也未触碰 `~/.dsh/profiles/desktop`。所有临时对抗脚本写在 `$TEMP/verify/`，工程内只新增本文件。

---

## 0. 被验证基线（冻结）

| 文件 | sha256（前 16 位） | 完整 sha256 | 行数 |
| --- | --- | --- | --- |
| `lib/index.js` | `8c9d8fda3a37e376` | `8c9d8fda3a37e37636c59eb7cb973384d8f62f79b94ea372c7d4e7c4ae82948a` | 2033 |
| `tests/smoke.mjs` | `83cae178702f1b38` | `83cae178702f1b38a455d209379aeebff2201ad6b0d341b6a5874d7fdd97f4f9` | 850 |
| `package.json` | `aa35daab97730b87` | `aa35daab97730b87b5a0a3037504ee9b7331a07066786108721bb84664e6d118` | version `0.4.1` |
| `cordis.patch.yml` | `c8f47f18d7cc8104` | `c8f47f18d7cc8104117e9203b94ab0d5eae3130bf505921781f4e6545477564d` | 未变 |

自检来源哈希与作者声明逐字节一致（`sha256sum` 输出已核对）。我把这 4 个文件复制到 `$TEMP/verify/snapshot-v041/` 做只读快照，下文所有实验与行号引用都对该快照，不随工程文件变动而漂移。

**内核侧基准**：`@deepseek-ai/* 0.2.0-rc.2`，取自 `app.asar` 直读副本 `$TEMP/kernel/dsh/node_modules/@deepseek-ai/`（287 个包）。核对其与工作区 `work/ref/` 副本关键文件 sha256 一致（`dsh-subagent/lib/index.js` 两支均为 `75b50b1c9452a6ae…`），排除"抽取失真"这一反驳路径。

---

## ① 判定

> ### 可用于生产（附条件）
>
> 加载面、Schema 合规、六问题的主干行为均已独立核实；作者声称修掉的两个"静默失效"（结算守卫落点、detached header）我都从内核源码与真实内核对象两个层面独立确认成立。
>
> 条件（不阻塞上线，建议下一版处理）：第 ⑥ 节的 6 条低severity问题，其中 P1（`config.maxMembers` 与 roster 上限分叉后的展示口径）与 P4（守卫 owner 变更后不重装）建议修；另外第 ⑦ 节列出的 4 项"只有真机才能验"的行为，本次只由作者探针日志佐证，我未独立复现。

---

## ② 验证环境与命令清单

环境：Windows，Node v24.18.0；bash（Git Bash）；内核源码来自 `app.asar` 抽取。

```bash
# 基线
sha256sum lib/index.js tests/smoke.mjs package.json cordis.patch.yml
# 加载面
node --check lib/index.js
grep -nE '^\s*(import|export).*@deepseek-ai|(require|import)\(\s*["'"'"']@deepseek-ai' lib/index.js
grep -n '@deepseek-ai' lib/index.js ; grep -nE '^export ' lib/index.js
# 内核服务存在性（"super(ctx, <name>)" 是 service 注册的唯一形式）
grep -rnE 'super\(ctx,\s*"[a-zA-Z]+"' work/ref/dsh/node_modules/@deepseek-ai --include=*.js
# 真实内核校验器 / 真实 tools.register()
node "$TEMP/verify/schema-check-v040.mjs"        # 同一脚本对 v0.4.1 跑的是 snapshot-v041
# 真实 cordis 下的 Proxy 行为
node "$TEMP/verify/proxy-guard.mjs"
# 真实 Session.fromRestore 头校验 + 删除守卫拦截路径
node "$TEMP/verify/final-checks-v041.mjs"
# 对抗用例全集
node "$TEMP/verify/adversarial-v041.mjs"
```

关键原始输出片段如下（§③④⑤ 内逐条对应）。

---

## ③ Schema 合规结论（独立重建判据）

判据不是抄插件注释，而是从 `app.asar` 直读的内核实现里抄出并**用真实内核函数复跑**。判据原文（`dsh-tools/lib/index.js`）：

- `CONSTRAINT_KEYWORDS = {type, oneOf, properties, required, additionalProperties, items, enum, const}`（`:34-43`）
- `ANNOTATION_KEYWORDS = {description, title, default, examples}`，且必须是 lossless JSON 数据（`:44-49`、`:198-205`）
- `SCHEMA_TYPES = [object, array, string, number, integer, boolean, null]`（`:50-58`）
- 各 type 允许的关键字：`properties/required/additionalProperties` 仅 `object`；`items` 仅 `array`；`enum/const` 仅 string/number/integer/boolean/null（`:241-260`）
- `required` 必须是字符串数组且**每个名字必须在 `properties` 里已声明**（`:155-159`）；`additionalProperties` 必须是 boolean（`:160`）
- `type` 与 `oneOf` 互斥（`:212-215`）；无 `type`/`oneOf` 时不得出现 `properties/required/...`（`:216-219`）
- `enum` 非空且元素类型匹配（`:298-301`）；`const` 类型匹配且若同时有 `enum` 必须落在 enum 内（`:302-308`)
- `tools.register(definition)`（`:2878-2887`）要求：`output` 为对象、`output.render` 是函数（`presentationMeta` 若存在也须是函数）；然后 **只** 调 `assertSupportedJsonSchema(output.schema)`。

**我独立确认了任务要求复核的两点——用真实 `register()` 跑反例**（stub `this.layers.effect`，其余是内核原函数）：

```
register() with parameters=non_object_root: ACCEPTED
register() with parameters=oneOf_root:       ACCEPTED
register() with parameters=invalid_keyword:  ACCEPTED
register() with parameters=bad_required:     ACCEPTED
register() with parameters=enum_wrong_type:  ACCEPTED
```

→ `register()` **不做 object-root 约束**，并且**完全不看 `parameters`**（`assertObjectJsonSchema` 只被 subagent/workflow 的 structured output 使用，`:792-811`、`:334-339`）。参数 schema 的真实约束点在别处：SDK 渲染期 `renderType → assertSupportedJsonSchema`（`:2236`、`:2443`）与 view 期 `snapshotJsonValue(parameters)` 必须可无损 JSON 化（`:3040-3042`）。所以四个工具的参数是**在每个 agent 的 tools SDK 渲染路径上**被校验的，我按这条路径也做了复现。

对 `lib/index.js` 六个工具逐一用**真实内核**核验（`$TEMP/verify/snapshot-v041`）：

```
plugin name=team-conductor inject=["agents","tools","systemPrompt"]
tools=team_overview,team_member_edit,team_capacity_set,team_message,team_member_add,team_member_delete

### team_overview
  real tools.register(): ACCEPTED
  assertSupportedJsonSchema(parameters): PASS
  assertSupportedJsonSchema(output.schema): PASS
  jsonSchemaToTs(parameters): OK     jsonSchemaToPy(parameters): OK
  parameters lossless-JSON: true (307 bytes, 2 properties, required=[])
  argument verdicts compared: 2 cases, 0 divergence(s)
### team_member_edit    register ACCEPTED; 2×PASS; Ts/Py OK; 1204 bytes, 9 props, required=[target,action]; 12 cases 0 divergence
### team_capacity_set   register ACCEPTED; 2×PASS; Ts/Py OK;  245 bytes, 2 props, required=[max_members];    5 cases 0 divergence
### team_message        register ACCEPTED; 2×PASS; Ts/Py OK;  271 bytes, 2 props, required=[target,message];  5 cases 0 divergence
### team_member_add     register ACCEPTED; 2×PASS; Ts/Py OK;  997 bytes, 8 props, required=[name,description,brief]; 11 cases 0 divergence
### team_member_delete  register ACCEPTED; 2×PASS; Ts/Py OK;  498 bytes, 4 props, required=[target];         5 cases 0 divergence
OVERALL: PASS — all tools register, all schemas valid, 0 argument-verdict divergences
```

结论：**六个工具的 `parameters` 与 `output.schema` 都能真的通过 `tools.register()`**，也都能通过 SDK 渲染与无损 JSON 投影。`output.schema` 六个工具共用同一个冻结对象 `TEXT_OUTPUT_SCHEMA`（`===` 判定为 true），root 是 `type:"object"` + `required:["text"]`，root 开放（未声明 `additionalProperties`）。

另外：插件自带的 `validateSubset`（`lib/index.js:687`）与内核 raw 校验器 `validateJsonSchemaValue` 在 **40 个构造用例**上"是否违规"的判定**完全一致**（仅措辞不同，属预期）。这一点比"schema 合法"更重要——说明它自建的手写校验没有与内核语义分叉。

---

## ④ 六问题主张核对表（主张 → 代码位置 → 反证尝试 → 结论）

### 问题 1：队友上下文饱和对 Lead 不可见 → `team_overview` 报占用/窗口/比率/等级 + `compact`

- **主张**：报出每个成员的 token 占用/窗口/比率/饱和等级（阈值 0.6/0.75/0.9；无窗口时绝对阈值 80000/140000/200000），并用 `team_member_edit(action=compact)` 触发内核压实。
- **代码位置**：`lib/index.js:426`（`effectiveBudget`）、`:432`（`saturationLevel`）、`:456`（`measureMember`）、`:810`（overview 的 capacity/成员字段）、`:1652` 附近（`compact` 用 `compactionService(ctx, live)` 双作用域解析）。
- **反证尝试**：(a) 断言 `unknown` 是不是编造——注入 `tokenMeter.measure` 抛异常与 `llm.resolveModelInfo` 抛异常；(b) 检查 `effectiveBudget` 在"预算 > 窗口"时是否让用户预期落空；(c) 查 compaction 是否真的可达（作者声称插件作用域取不到，需退回 `agent.ctx`）。
- **实测输出**：
  ```
  6b team_overview with throwing meter/llm
     known=false source=live detail="meter exploded" tokens=null     <- 不编造数值，诚实降级
  7  llm.resolveModelInfo throws -> absolute thresholds used
     tokens=150000 window=null level=near_saturated                  <- 回退到绝对阈值阶梯，正确
  ```
  compaction 可达性：profile `cordis.yml:748-760`（与 `:930-936` 重复）确有一层
  `- id: compaction / name: cordis:group / group: true / isolate: {compaction: true, toolResultPruner: true}`，
  而 `team-conductor` 自己挂在 profile **顶层**（`cordis.yml:2103-2108`）。isolate 组把 compaction 提供了在独立作用域里，
  所以插件根 ctx 取不到、agent 作用域能取到——**作者引入 `compactionService(ctx, agent)` 双作用域回退是可证实的必要修复**，
  不是过度设计。
- **结论**：**成立**。`effectiveBudget = min(window, budget)`（`:426-429`）是刻意的保守取法，不会掩盖窗口压力；`remaining` 语义自洽（`max(0, budget-tokens)`）。

### 问题 2：成员上限 8 且无退役工具 → `team_capacity_set` / `retire`

- **主张**：写 `teamService.roster.maxMembers` 直接改上限；`retire` 标记 + 调 `roster.stopTeammates` 释放运行激活。
- **代码位置**：`lib/index.js:228`（`maxMembers`）、`:1337`（`raiseCeiling`）、capacity 工具与 `retire` 分支。
- **反证尝试**：读内核确认 `roster.maxMembers` 真的是判据读点；grep 内核所有 `maxMembers` 读取点；把上限改到低于已用数；核对重启后是否回退。
- **内核证据**（`dsh-experimental-agent-team/lib/index.js`）：
  - `TeamRoster` 声明 `maxMembers;`（`:368`），构造赋值 `this.maxMembers = maxMembers`（`:380`），
  - 唯一的准入判据 `if (state.members.length >= this.maxMembers) throw new TeamError("Team member limit ...", "TEAM_MEMBER_LIMIT")`（`:564`），
  - 服务构造 `this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config.maxMembers)`（`:1717`）。
  → **写 `roster.maxMembers` 确实改变强制点**；全内核再无其它读 `maxMembers` 的地方（`config.maxMembers` 仅 `:1689/:1706/:1717`）。
  → **重启后回到 profile 配置值**：§1717 在构造时从 `config` 取，`TeamService.config` 只在 ctor 由 profile config 定型（`:1704-1710`），
    运行期没有任何回写 `config.maxMembers` 的代码 —— 与工具返回的 note 一致（`:1017` 附近"applies to this process only"）。
  → `stopTeammates` 存在：`:540-542` → `lifecycle.withTimeout(ctx.subagents.drainContinuableChildren(root, childIds))`。
- **实测输出**：
  ```
  3a max_members=1 with 2 used -> refused: cannot lower the ceiling to 1: 2 member slots are already taken
  3b max_members=3 accepted, writes roster.maxMembers -> before=8 after=3 used=2 free=1
  3c config.maxMembers NOT updated (stale) -> config.maxMembers=8 vs roster.maxMembers=3
  ```
- **"上限 8"的说法要打折扣**：内核 **`DEFAULT_MAX_MEMBERS = 16`**（`:1669`），不是 8。
  "8" 是本机 desktop profile 的配置值（`~/.dsh/profiles/desktop/cordis.yml:1324  maxMembers: 8`）。
  但 `team_capacity_set` 的模型可见 description 写的是 *"The shipped team bundle caps a Team at 8 members"*（`lib/index.js:1000` 附近），
  policy 文本也写"本机为 8"（`:1500` 附近）——**把"本 profile 配置值"表述成了"shipped bundle 的固有上限"**，是事实性措辞错误（见 ⑥ P2）。
- **结论**：**成立**（机制成立），但描述措辞**部分不成立**。

### 问题 3：subagent 不可寻址 → `team_message` 支持 `target = child session id`

- **主张**：走 `ctx.subagents.sendMessage` 直达非 roster 的 continuable subagent；团队版 `send_message` 只认 roster 成员。
- **代码位置**：`lib/index.js:588`（`resolveTarget` 解析顺序：lead → durable name → alias → live child id → session-id 形状）、`:635`（`deliver`）、`:307`（`resolveService` 双作用域）。
- **反证尝试**：核对内核签名/arity；核对"团队版只认 roster"这句话；核对 child id 形状判据是否过宽。
- **内核证据**：`subagents` 服务确有 `async sendMessage(sender, targetId, content, options)`（`dsh-subagent/lib/index.js:2896`），
  服务形态与插件调用 `subagents.sendMessage(caller, resolved.id, content, {signal})` **完全对齐**（arity 4，参数语义一致）。
  团队版 `send_message` 的落点 `resolveActiveMember` 明确 `throw new TeamError('active teammate "<name>" not found', "TEAM_MEMBER_NOT_FOUND")`（agent-team `:357`），
  即只按 durable name 解析 —— **作者这句话成立**。
  另：内核模型可见工具名是 `spawn_teammate/send_message/list_agents/wait_agent/interrupt_agent/team_task_*`
  （`dsh-experimental-tool-agent-team/lib/index.js:243-459`），与本插件 6 个工具名**零冲突**。
- **实测输出**：
  ```
  5x session-id shape is accepted as a child id -> kind=child id=3f2504e0-4f89-11d3-9a0c-0305e82c3301
  5y 16-hex shape accepted -> kind=child
  4a alias 'beta' 等于另一成员 durable name -> kind=teammate coreName=beta  (durable name 优先，胜过 alias)
  ```
- **结论**：**成立（静态）**。真机端到端投递未验（见 ⑦）。

### 问题 4：完成通知重复投递 → `notifySettlement` 去重守卫

- **主张**：包装"同一 Activation 的第二次通知"予以抑制；不同 Activation 正文相同则放行。
- **代码位置**：`lib/index.js:1683`（`GUARD_MARK`）、`:1694`（`resolveActivationRegistry`）、`:1716`（`wrapMethodOnce`）、`:1732`（`ensureGuard`）、`:1776`（`removeSettlementGuard`）。
- **反证尝试**（这条是本次最关键的怀疑点，我做了三层）：
  1. **落点是否真的存在**：全内核 `notifySettlement` 只有 4 处出现（`dsh-subagent/lib/index.js:1248` 调用、`:1254` 定义，
     以及 `lib/types/continuation-activation.js` 的同名镜像）。定义它的类是 `ContinuableActivationRegistry`（`:756`），
     **不是** `subagents` 服务（服务类在 `:2810+`，只有 `sendMessage/interrupt/drain*/startContinuable/...`，没有 `notifySettlement`）。
     实例链是 `subagents` 服务 → `this.continuations`（`SubagentContinuationManager`，`:2826/:2842`）→ `this.activations`（registry，`:1662`）。
     → 作者 v0.4.1 把落点改成 `subagents.continuations.activations` **是必要且正确的**；v0.4.0 及以前包 `subagents.notifySettlement` 必然落到 `unsupported` 静默失效（我已复现，见下）。
  2. **cordis Proxy 是否会破坏覆盖**：用**真实 cordis 4.0.4** 起 `Context` + 真 `Service` 子类实测：
     ```
     ctx.get("subagents") typeof: object
     util.types.isProxy(service): true                     <- 确认是 Proxy
     raw instance reachable via symbols.original: true     <- 真身可达
     ensureGuard() -> guardStatus = failed (v0.4.0 的引用相等判据)
     two calls w/ SAME activation reached the original 1 time(s)   <- 但包装其实生效了
     state.stats.suppressedNotices = 1
     after 4 more ensureGuard() calls: statuses=[failed,failed,failed,failed]
     wrapper nesting depth visible in the stack of one call: 4     <- 每次工具调用再包一层
     ```
     → **Proxy 不是 defineProperty 的问题**（`defineProperty` 无 trap，落到真身）；真正的坑是 `owner[name] !== wrapper` 这种"读回比较"，
     因为 traceable Proxy 的 `get` 会把函数再包一层 shadow proxy。v0.4.1 改用
     `Object.getOwnPropertyDescriptor(owner, name).value === wrapper`（`:1727-1728`）+ wrapper 上的 `GUARD_MARK`（`:1719/:1721`）
     恰好绕开这个坑（`getOwnPropertyDescriptor` 同样无 trap）；我实测 `GUARD_MARK` 经 Proxy 读取也能读到（string 值不再被包）。
  3. **误伤范围**：`WeakSet` 只以 Activation 对象为键（`:1747-1756`），"两个不同 Activation、正文相同"必然放行（实测不同 activation 各达 1 次）；
     `activation` 为 null/非对象时跳过登记转直接转发。"同一 Activation 第二次调用"在 0.2.0-rc.2 里只可能来自重复投递本身
     （registry 只在 `finishDisposal` 末尾调一次）。
- **实测输出**（v0.4.1，registry 不存在时**不谎报 active**）：
  ```
  9a settlement guard: registry absent -> unsupported (no silent 'active')  -> status=unsupported
  ```
- **结论**：**成立**（v0.4.1 的落点与判据都正确；v0.4.0 及以前的版本**不成立**，属静默失效，已被作者修正）。
  真机"守卫确实拦住一次真实重复通知"未由我独立复现（见 ⑦）；我独立证明的是**路径存在 + 手法在真 Proxy 下可用**。

### 问题 5 / 6：edit 报状态过期无恢复指引、队友爱写外部补丁脚本 → 注入 policy 文本

- **主张**：用 `systemPrompt.section` 给每个 Team 成员注入操作纪律文本。
- **代码位置**：`lib/index.js:1795`（`policyText`）、`:1846`（`scoped.systemPrompt?.section?.({...})`）。
- **反证尝试**：确认 `systemPrompt` 服务真实存在且 `section()` 是真 API（不是臆造）。
- **内核证据**：`dsh-system-prompt/lib/index.js:213  super(ctx, "systemPrompt")`、`:240  section(section) → layers.effect(... sections.insert(section.name, section) ...)`。
  注入是 scoped 的（`scoped = agent.ctx`），符合"每个 agent 一份"的意图。
- **结论**：**成立（静态）**。"文本最终出现在模型提示里"未验（见 ⑦）。

### 附加主张（作者未列入六问题但同等重要）

| 主张 | 代码位置 | 反证与证据 | 结论 |
| --- | --- | --- | --- |
| 未加载成员用 `sessions.prepare(id,{eventState:"detached"})` 造副本再 `measure`，失败表达为 `known:false` 不编造 | `lib/index.js:368` `detachedSession` | 见下方专项 | **成立（v0.4.1），v0.4.0 不成立** |
| `sealMemberInKernel` 不能对 active 记录写日志 | `:1371` | 见下方专项 | **成立** |
| `children` 只列本队子代理 | `:795-797` | 代码为 `agent.session?.header?.parentSession === membership.root.id`，注释明示"another session's subagents belong to a different Lead" | **成立（静态）** |
| 删除墓碑成员后拒绝投递（`ensureDeleteGuard`） | `:1400` `blockedTarget`、`:1416` `ensureDeleteGuard` | 见下方专项 | **成立** |

#### 专项 A：detached 副本的 header（作者 v0.4.1 的招牌修复）

我按任务要求去 `dsh-session` 逐个字段抄判据，并用**真实 `Session.fromRestore`** 复现：

`validateSessionHeader`（`dsh-session/lib/index.js:1037-1053`）的完整要求：
`seedLength` 必须**不存在**（`:1040`）；`version === 4`（`:1041`）；`id` 必须等于会话 id（`:1042`）；
`createdAt` 必须是非负安全整数（`:1043`）；`isSeeded` **必须是 boolean**（`:1049`）；
可选但若存在须合法：`cwd`(绝对路径) / `parentSession`(string) / `origin`(必须是 `"subagent"`) / `delegationDepth`(非负安全整数) / `agentPreset`(string)。
detached 走 `Session.fromRestore`，其 mode ≠ `"snapshot"`，因此 `restoredHeader = validateRestoredSessionHeader(id, header)`（`:1325`），
即**不会**走 `prepare` 里"从部分 meta 补 header"的那段（`:1699-1709`）—— 这正是旧版报 `version must be 4, got undefined` 的原因。

实测（真实内核）：
```
  FIXED header (v0.4.1 shape) -> ACCEPTED (header.version=4, id=s1, seq=1)
  OLD partial meta -> REJECTED: session header version must be 4, got undefined   <-- 复现作者真机观察
  version: 3 / version absent          -> rejected: session header version must be 4, ...
  createdAt absent / non-integer / neg -> rejected: ... createdAt must be a non-negative safe integer
  isSeeded absent / string             -> rejected: ... isSeeded must be a boolean
  id mismatched                        -> rejected: ... id "other" does not match session id "s1"
  seedLength present                   -> rejected: session header has invalid field "seedLength"
  cwd relative / origin bogus / delegationDepth negative / agentPreset non-string -> 全部 rejected
```
对照 v0.4.1 构造的 header（`lib/index.js:388-400`）：显式给 `version:4`、`id`、`createdAt`（`finite(persisted.createdAt) ?? Date.now()`）、`isSeeded`（`persisted.isSeeded === true`），
可选字段按需透传，**不出现 `seedLength`**，对象是字面量（plain prototype）→ 逐字段**全覆盖**判据。
残留：`finite()` 不检查 safe-integer，损坏的持久 header（负数/小数 createdAt）会抛错 → 被 `measureMember` catch 成 `known:false`（安全降级，不编造）；`version: 4` 是硬编码（见 ⑥ P5）。

另：`prepare` 按内核文档**不进 store**（`:1661-1675` "Build a session WITHOUT entering it into the store"，服务文档 `:1680`），
所以 detached 副本不会污染 `sessions` store、也不会触发 `session/created`（`created` 只由 `announce` 发，`:1775+`）。
`tokenMeter` 侧：`states = new WeakMap()`（`dsh-token-meter/lib/index.js:609`）**以 session 对象为键**，`measure()` → `_sync(session)`（`:641-642/:706`）。
detached 是**新对象**，只会得到自己的弱键项，与在册会话互不干扰，且副本测完即失去引用、随 GC 消失 → **不污染、不泄漏**。
（`_sync` 内部是否还有别的强引用我没逐行读完，见 ⑦。）

#### 专项 B：`sealMemberInKernel` 的合法性（作者 v0.4.1 的另一处修复）

内核投影只允许 `provisioning → active|failed`：
`dsh-experimental-agent-team/lib/types/projection.js:184 applyCurrentTeamEvent`，`prior === undefined` 时要求 `member.phase === 'provisioning'`（**抛错点 `:196`**），
`prior` 存在时要求不可变身份字段不变（**`:200`**），且 `if (prior.phase !== 'provisioning' || member.phase === 'provisioning') throw` —— **抛错点 `:203`，正是作者引用的 `:196-203`**。
所以对 `active` 记录追加 `phase:"failed"` 是非法 append，会被投影拒绝。
实测（stub journal 记录每次 append）：
```
  8a seal active member        -> result=immutable-active  appends=0     <- 不写日志，修复成立
  8b seal provisioning member  -> result=sealed-provisioning appends=1 lastPhase=failed  <- 只走合法边
  8c seal unknown member       -> result=not-in-roster     appends=0
```
→ 非法 append 的路径已被彻底切断；工具返回也会用 `sealNote`（`:1498`）把 `immutable-active` 解释成"上游不许改写，墓碑+投递守卫才是删除的实际效果"（措辞诚实）。

#### 专项 C：删除守卫（`ensureDeleteGuard`）真的能拦住吗

- 包装对象是 `agentTeams` **服务**（真 cordis Service → Proxy）。手法与专项 ④-2 同源（descriptor 判据），**已证明在真 Proxy 下可用**。
- 拦截路径核对：内核模型可见工具 `send_message` 的实现是 `ctx.agentTeams.sendMessage(callingAgent(...), {target, content, signal})`
  （`dsh-experimental-tool-agent-team/lib/index.js:312`），**经过服务**，所以 own-property wrapper 会被命中。
- 实测（真 wrapper + 真墓碑）：
  ```
  ensureDeleteGuard -> active
  send to "ghost"      -> REFUSED: teammate "ghost" was deleted by dsh-team-conductor (2026-01-01T00:00:00.000Z); ...
  send to "ghostly"    -> DELIVERED   (alias 不解析成 durable name，内核本来就只认 durable name)
  send to "lead"       -> DELIVERED
  send to "someone-else" -> DELIVERED
  state.stats.blockedDeletedSends = 1
  idempotency: re-drive -> active; sendMessage still refused for ghost? yes
  ```
- **结论**：**成立**。误伤范围窄（仅 durable name 命中墓碑；`lead` 与不存在的目标放行；异常被 catch 成放行）。

---

## ⑤ 对抗用例结果（v0.4.1，34 项，0 FAIL）

```
TOTAL 34; FAILED 0
```
逐条（左=用例，右=实测）：

| # | 用例 | 结果 |
| --- | --- | --- |
| 1a | 无 `agentTeams` 服务 | `ensureGuard` → `pending`（不谎报 active） |
| 1b | 无 `agentTeams` 时 `team_overview` | 不抛错，`members=1 capacity={used:0,max:8,free:8,...} notes=3` |
| 2a | `listMembers` 返回 `[]` | `used=0 max=8 free=8 full=false` |
| 2b | `listMembers` 抛异常 | 降级到本地视图，`members=1`，不抛错 |
| 3a | `max_members=1` 而已用 2 | 拒绝：`cannot lower the ceiling to 1: 2 member slots are already taken` |
| 3b | `max_members=3` | 接受并写入 `roster.maxMembers=3`，返回 `before=8 after=3 used=2 free=1` |
| 3c | 上限改动后的 config | `config.maxMembers=8` 未同步（见 ⑥ P1） |
| 4a | alias 与另一成员 durable name 撞车（alias=`beta`） | durable name 优先，解析到 `beta` 本人 |
| 4b | alias=`lead` | 解析为 Lead 伪行（`kind=lead`） |
| 4c | 某成员 alias 恰好是 `lead` | 永远不可达，静默被 Lead 分支遮蔽（见 ⑥ P3） |
| 5 | target = 空串 / 纯空白 / 5000 字符 / `../../etc/passwd\0` / 含换行 / `0` / `null` | 全部被拒，错误信息明确（含 known teammates 提示） |
| 5x/5y | UUID 形状、16-hex 形状 | 接受为 child id（预期内的宽松形状，见 ⑥ P6） |
| 6b | `tokenMeter.measure` 抛异常 | `known=false source=live detail="meter exploded" tokens=null`（不编造） |
| 7 | `llm.resolveModelInfo` 抛异常 | 回退绝对阈值：`tokens=150000 window=null level=near_saturated` |
| 8a-c | seal active / provisioning / 不存在 | `immutable-active`(0 append) / `sealed-provisioning`(1 append) / `not-in-roster` |
| 8d | renameMember 撞另一 durable name / 另一 alias / 同自己 durable name / 空 / >64 字符 | 全部正确拒绝 |
| 8d' | renameMember 撞**自己**的 formerNames | **被接受**（见 ⑥ P6） |
| 8e | renameMember 到空闲名字 | 接受，`formerNames` 正确累积 |
| 9a | `subagents` 无 activation registry | `unsupported`（不谎报 active） |
| 9b | 删除守卫安装 + 拦截 | `active`，墓碑目标被拒、其他放行、重复驱动仍幂等 |

未纳入本轮实测的对抗面（诚实声明）：`task_id` 不存在 / `revision` 过期 / `reassign` 时成员正 running —— 我用**代码审查**代替（见 ⑦ 与 ⑥ P6 说明），没有构造真任务板来跑 CAS 竞争。

---

## ⑥ 问题清单（按严重度）

> 全部为**非阻塞**问题；没有发现致命项。

**P1（中）运行期改上限后，`config.maxMembers` 与 `roster.maxMembers` 长期分叉，展示口径可能自相矛盾。**
- 最小复现：`3c`（已跑）→ `team_capacity_set(max_members=3)` 之后 `team_overview` 里
  `capacity.max=3` 但 `capacity.configured=8`。任何**其它**读取 `config.maxMembers` 的 UI/消费者会继续按 8 显示，
  而准入按 3 执行。
- 影响：模型/用户可能基于 `configured` 判断容量。无功能错误，属口径问题。
- 建议修法：`team_capacity_set` 顺带把 `service.config.maxMembers` 也写成新值（两者本就是同一部署预算），
  或把 `configured` 明确改名为 `configuredAtStartup` 并在描述里说明它与生效值不同。
- 建议改的人：Lead（`lib/index.js`，capacity 工具 / overview payload）。

**P2（低）`team_capacity_set` 的模型可见描述把内核默认值说错。**
- 证据：内核 `DEFAULT_MAX_MEMBERS = 16`（`dsh-experimental-agent-team/lib/index.js:1669`）；
  本机 profile 才是 8（`cordis.yml:1324`）；而 description 写 "The shipped team bundle caps a Team at 8 members"，policy 写"本机为 8"。
- 影响：模型对默认上限的认知错误（本 profile 下结论恰好对，换 profile 就错）。
- 建议修法：改成"the configured ceiling (this profile: 8; kernel default 16)"，或干脆只报 `max`。
- 建议改的人：Lead。

**P3（低）成员的 alias 若字面上是 `lead`，则该 alias 永远不可达。**
- 最小复现：`4c`（已跑）→ `resolveTarget(..., "LEAD")` 返回 `kind=lead`，成员被静默遮蔽。
- 建议修法：`action=alias` 时拒绝 `lead`（大小写不敏感），或 `resolveTarget` 在 alias 命中时优先于 Lead 分支。
- 建议改的人：Lead。

**P4（低）守卫 install 后不重新校验 owner，fiber/服务重绑后会"报 active 但不再生效"。**
- 证据：`ensureGuard`（`:1737-1740`）与 `ensureDeleteGuard`（`:1421-1424`）都是 `state.guard !== undefined` 即直接返回 `active`，
  不再重新解析 owner 身份。而 `SubagentContinuationManager` 是在 `ctx.inject(["agents"], cb)` 里创建并赋给 `service.continuations` 的
  （`dsh-subagent/lib/index.js:2837-2847`），fiber 重载会换一个新的 registry 实例。
- 另有次生现象：`apply` 期的首次 `ensureGuard` 与 `internal/service` 钩子都可能在 `service.continuations` 赋值**之前**触发，
  此时会得到瞬时 `unsupported`（因为 service 已存在、registry 还没有），只能靠下一次工具调用自愈。
- 影响：HMR/重载后去重与删除守卫可能静默失效而 `/status` 仍报 active。
- 建议修法：把 `state.guard` 的早退条件改成"重新解析到的 owner === `state.guard.owner`"，
  owner 变了就重装；`internal/service` 钩子里对 `subagents` 也延后一拍（或依赖工具调用）并把瞬时态记为 `pending` 而非 `unsupported`。
- 建议改的人：Lead。

**P5（低）`detachedSession` 硬编码 `version: 4`，且 `createdAt` 只做 `finite()` 而非 safe-integer 校验。**
- 证据：`:388-400`；内核 `SESSION_FORMAT_VERSION` 与 `validateSessionHeader` 要求 safe integer（`dsh-session:1043`）。
- 影响：内核升到 v5 时冷成员测量全部降级为 `unknown`（安全但不静默正确）；损坏 header 会抛错→降级（可接受）。
- 建议修法：从持久 header 透传 `version`（缺省回退 4）并在非 safe-integer 时按 `Date.now()` 兜底，或读 `SESSION_FORMAT_VERSION`（但插件不 import 内核包，只能透传）。
- 建议改的人：Lead。

**P6（低）若干边界语义宽松/不对称。**
- (a) `whichTimeout`（`:1613`）用 `Promise.race`，超时胜出后原 promise 若再 reject 会成为 unhandledRejection（建议 `promise.catch(()=>{})` 挂尾）。
- (b) `renameMember`（`:1478`）的冲突检查 `if (key === coreName) continue;` 会跳过**自己**的 `formerNames`，所以可以把成员改回自己曾用过的名字（实测 8d'-omega 被接受）。不是跨成员冲突，但"formerNames 参与冲突检查"的意图没有覆盖自身；如属有意，建议在注释里写明。
- (c) `looksLikeSessionId` 接受任意 16+ hex（`:577`），一个恰好 16 位十六进制的**名字**会被当成 child id（假阳性）。
- (d) `reassign` 的 `task_id` 不存在/revision 过期时只写 warning 不失败（`:918-931`）；对"一次调用完成交接"的语义而言，
  任务没交接但简报已发出，调用者只看 effects 容易误判成功（建议把 `taskUpdate` 结果放进返回体的显式字段而不是只管 warnings）。
- 建议改的人：Lead。

---

## ⑦ 未能验证的事项（诚实列出）

1. **真机端到端（最重要的一项空缺）**：我没有启动真实 Harness 进程跑 live 场景。因此下列行为**只由作者探针日志佐证，非我独立复现**：
   - 结算守卫在真实 subagent 结束时确实拦下一次重复通知（作者的 `PROBE-SETTLE-GUARD status=active scope=subagents.continuations.activations suppressed=1 forwarded=1`）；
   - `team_message` 用 child session id 真的把消息投给了一个非 roster 子代理；
   - policy 文本真的出现在成员提示中；
   - `webServer` 状态路由真的返回 200；
   - `internal/service` 钩子在真实装载顺序下的触发时机。
   理由：本任务要求只读 + 只写 `verification.md`，起一个 DSH 实例会与作者正在安装/运行的实例互相干扰；我改用了"内核源码取证 + 真实内核对象复跑"的替代路径（见 ④）。
2. **`task_id` / `revision` CAS 竞争 / `reassign` 时成员正 running**：只做了代码审查（`getTask` → `updateTask({expectedRevision: task.revision, action:"reassign", owner: coreName})`，失败仅 warning），未构造真任务板并发场景。
3. **`dsh-token-meter` 的 `_sync` 内部**：我确认了 `states` 是**以 session 对象为键的 WeakMap**（`:609`）且 `measure` 入口即 `_sync`（`:641-642`），
   因此 detached 副本不会污染在册会话、也不会造成无界增长；但 `_sync` 内部是否另持有强引用、是否注册监听器，我**没有逐行读完**（`:706` 起）。
4. **`seal_kernel` 对 `provisioning` 成员的竞态**：作者注释称 `TeamRoster.settleProvisioning` 遇到非 provisioning 记录会早退（内核 `:673/:713`），故不会与创建者竞态。我核对了该早退存在，但未做真实并发复现。
5. **`systemPrompt.section` 的 order=640 与团队策略 section 的相对顺序**：`SECTION_ORDER = 640`（`lib/index.js:52`，注释称"just after TEAM_POLICY (600)"）——我**没有**去内核/profile 里核实 TEAM_POLICY 是否真的用 600，属未核实项。

---

## 附：本次验证对代码的实际影响（作者已采纳）

| 时点 | 我给出的证据 | 作者动作 |
| --- | --- | --- |
| 基线 1708 行 | `notifySettlement` 只在 `ContinuableActivationRegistry`（`dsh-subagent:1254`），不在 `subagents` 服务上 → 旧守卫必然 `unsupported` 静默失效；并用真 cordis 证明 `owner[name] !== wrapper` 会被 Proxy 的 get 陷阱骗到（`guardStatus=failed` + 每次工具调用再包一层） | v0.4.1 改落点为 `subagents.continuations.activations`，改用 descriptor + `GUARD_MARK` 判幂等 |
| 基线 1708 行 | `sealMemberInKernel` 对 active 记录追加 `phase:"failed"` 与投影不变式冲突（`projection.js:196-203` 只允许 `provisioning→active|failed`） | v0.4.0/0.4.1 只在 `provisioning` 时密封，其余返回 `immutable-*` 且不写日志（我在 8a 复测 0 append） |
| v0.4.0 真机观察 | `sessions.prepare({eventState:"detached"})` 把 `meta` 当**完整 header** 校验（`Session.fromRestore` → `validateRestoredSessionHeader`，`dsh-session:1325`） | v0.4.1 补齐 `version/id/createdAt/isSeeded`（我用真实 `Session.fromRestore` 逐字段验到全覆盖） |