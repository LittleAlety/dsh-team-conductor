/**
 * dsh-team-conductor — host half.
 *
 * One plugin that turns the Agent Teams surface into a single observable
 * control plane instead of a pile of guesswork:
 *
 *   team_overview       — roster + per-member context pressure + capacity +
 *                         the settlement-notice ledger of this session.
 *   team_member_edit    — edit one member: alias / describe / priority / tags /
 *                         token budget / re-brief / retire / restore / compact /
 *                         interrupt.
 *   team_capacity_set   — raise or lower the Team member ceiling at runtime.
 *   team_message        — message a durable teammate by name or alias, *or*
 *                         steer a non-roster continuable subagent by its id.
 *
 * It also installs a settlement-notice guard: a second notice for the *same
 * Activation object* is suppressed (that is unambiguously a double delivery),
 * while two notices from two different activations are left untouched.
 *
 * Why this file imports nothing from `@deepseek-ai/*`: profile plugins live
 * outside `app.asar` and cannot resolve the harness packages (verified —
 * `node -e "import('@deepseek-ai/dsh-tools')"` from the profile fails with
 * ERR_MODULE_NOT_FOUND, and every shipped profile plugin bundles or avoids
 * them). Everything here is reached through the host cordis context, and tool
 * definitions are authored as plain registry definitions whose `parameters`
 * and `output.schema` use exactly the JSON-Schema subset `tools.register()`
 * accepts (type/oneOf/properties/required/additionalProperties/items/enum/
 * const + annotations).
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Cordis plugin name. */
export const name = "team-conductor";

/** Services required by this plugin. `agentTeams`, `subagents`, `tokenMeter`,
 * `compaction`, `sessions`, `sessionPersistence`, `llm` and `webServer` are
 * all reached lazily so the plugin still loads in a composition that has no
 * Agent Teams bundle mounted (degraded mode). */
export const inject = ["agents", "tools", "systemPrompt"];

/** Stable identity of the plugin, used by the status route and the store. */
const PLUGIN_ID = "dsh-team-conductor";
/** Reported version; kept in sync with package.json by the release script. */
const PLUGIN_VERSION = "0.4.1";

/** Prompt section: register just after the repository's TEAM_POLICY (600). */
const SECTION_NAME = "team:conductor:policy";
const SECTION_ORDER = 640;

/** Loopback status route (same shape as other profile plugins). */
const STATUS_ROUTE = "/dsh-team-conductor/status";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** How much context pressure counts as saturated, as a window ratio. */
const RATIO_WATCH = 0.6;
const RATIO_NEAR_SATURATED = 0.75;
const RATIO_OVER = 0.9;
/** The same ladder when a routed context window is unavailable. */
const TOKENS_WATCH = 80000;
const TOKENS_NEAR_SATURATED = 140000;
const TOKENS_OVER = 200000;

/** Team limits, used only when the Team service cannot report its own. */
const FALLBACK_MAX_MEMBERS = 8;

/** One shared output contract: a single rendered text block, JSON inside. */
const TEXT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    text: { type: "string", description: "Rendered JSON result." }
  },
  required: ["text"]
});

/** Keys this plugin understands in its bundle config. */
const KNOWN_CONFIG_KEYS = new Set([
  "dedupeSettlementNotices",
  "blockDeletedTargets",
  "defaultContextWindow",
  "maxOverviewNotices",
  "freshProvider",
  "forkProvider",
  "verboseLogging"
]);

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

/** SHA-256, truncated — used as a content identity for settlement notices. */
function digest(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

/** Round to a fixed number of decimals without float noise. */
function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Number or undefined; rejects NaN/Infinity. */
function finite(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** Resolve the DeepSeek Harness home: `$DSH_HOME`, else `~/.dsh`. */
function dshHome() {
  const env = process.env.DSH_HOME;
  const configured = typeof env === "string" && env.trim().length > 0 ? env.trim() : undefined;
  if (configured === undefined) return resolve(join(homedir(), ".dsh"));
  if (configured === "~") return resolve(homedir());
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(join(homedir(), configured.slice(2)));
  }
  return resolve(configured);
}

/** Store directory for this plugin, under the harness home. */
function storeDir() {
  return join(dshHome(), PLUGIN_ID, "teams");
}

/** Filesystem-safe store file for one Team root. */
function storeFile(rootId) {
  const safe = String(rootId ?? "unknown").replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 200);
  return join(storeDir(), `${safe}.json`);
}

/** One empty Team sidecar store. */
function emptyStore(rootId) {
  return {
    version: 1,
    rootId: String(rootId ?? ""),
    updatedAt: Date.now(),
    members: {},
    capacity: {},
    stats: {}
  };
}

/** Read one Team sidecar store, tolerating a missing or corrupt file. */
function readStore(rootId) {
  try {
    const parsed = JSON.parse(readFileSync(storeFile(rootId), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return emptyStore(rootId);
    return {
      ...emptyStore(rootId),
      ...parsed,
      members: parsed.members !== null && typeof parsed.members === "object" && !Array.isArray(parsed.members) ? parsed.members : {},
      capacity: parsed.capacity !== null && typeof parsed.capacity === "object" && !Array.isArray(parsed.capacity) ? parsed.capacity : {},
      stats: parsed.stats !== null && typeof parsed.stats === "object" && !Array.isArray(parsed.stats) ? parsed.stats : {}
    };
  } catch {
    return emptyStore(rootId);
  }
}

/** Atomically persist one Team sidecar store. */
function writeStore(rootId, store) {
  const file = storeFile(rootId);
  mkdirSync(storeDir(), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...store, rootId: String(rootId ?? ""), updatedAt: Date.now() }, null, 1)}\n`, "utf8");
  renameSync(temp, file);
}

/** Mutate one member's sidecar record and flush. */
function updateMemberRecord(rootId, coreName, mutate) {
  const store = readStore(rootId);
  const current = {
    alias: undefined,
    description: undefined,
    priority: undefined,
    tags: [],
    tokenBudget: undefined,
    retired: false,
    retiredAt: undefined,
    notes: [],
    ...(store.members[coreName] ?? {})
  };
  const next = mutate({ ...current }) ?? current;
  store.members[coreName] = next;
  writeStore(rootId, store);
  return next;
}

// ---------------------------------------------------------------------------
// host service accessors (everything is optional)
// ---------------------------------------------------------------------------

/** Team service, when the Agent Teams bundle is mounted. */
function teamService(ctx) {
  try {
    return ctx.get("agentTeams");
  } catch {
    return undefined;
  }
}

/** Resolve one exact live Agent's Team membership, or undefined. */
function membershipOf(ctx, agent) {
  if (agent === undefined || agent === null) return undefined;
  const service = teamService(ctx);
  if (service !== undefined && typeof service.tryMembership === "function") {
    try {
      return service.tryMembership(agent);
    } catch {
      return undefined;
    }
  }
  // Degraded: without the Team service only top-level roots are workplaces.
  try {
    if (agent.session?.header?.parentSession === undefined) {
      return { root: agent, id: agent.id, role: "lead", name: "lead" };
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Current Team member ceiling, from the live roster when possible. */
function maxMembers(ctx) {
  const service = teamService(ctx);
  const rosterMax = finite(service?.roster?.maxMembers);
  if (rosterMax !== undefined && rosterMax >= 1) return rosterMax;
  const configMax = finite(service?.config?.maxMembers);
  if (configMax !== undefined && configMax >= 1) return configMax;
  return FALLBACK_MAX_MEMBERS;
}

/** Runtime members visible to one caller: the service view when present. */
function memberRows(ctx, caller) {
  const service = teamService(ctx);
  if (service !== undefined && typeof service.listMembers === "function") {
    try {
      const rows = service.listMembers(caller);
      if (Array.isArray(rows)) return rows;
    } catch {
      /* degrade to the local view */
    }
  }
  const rows = [{ id: caller.id, name: "lead", role: "lead", status: caller.status === "running" ? "running" : "inactive", diagnostics: [] }];
  for (const agent of listAgents(ctx)) {
    let parent;
    try {
      parent = agent.session?.header?.parentSession;
    } catch {
      continue;
    }
    if (parent !== caller.id) continue;
    rows.push({
      id: agent.id,
      name: `child-${String(agent.id).slice(0, 8)}`,
      role: "teammate",
      status: agent.status === "running" ? "running" : "inactive",
      diagnostics: []
    });
  }
  return rows;
}

/** Every live Agent in the registry, tolerating a missing service. */
function listAgents(ctx) {
  try {
    const agents = ctx.get("agents");
    if (agents !== undefined && typeof agents.list === "function") return agents.list() ?? [];
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Resolve one service the way the shipped profile actually mounts it.
 *
 * Several host services (`subagents`, `compaction`) are mounted inside an
 * `isolate:` group that an Agent is created under, so they are reachable from
 * that Agent's scoped context while the plugin's own context reports them
 * absent. Looking in both scopes is what makes the conductor work on a real
 * profile instead of only under the fake context in tests.
 */
function resolveService(ctx, serviceName, agent) {
  try {
    const direct = ctx.get(serviceName);
    if (direct !== undefined && direct !== null) return { service: direct, scope: "plugin" };
  } catch {
    /* fall through to the agent scope */
  }
  if (agent !== undefined && agent !== null) {
    try {
      const scoped = agent.ctx?.get?.(serviceName);
      if (scoped !== undefined && scoped !== null) return { service: scoped, scope: "agent" };
    } catch {
      /* ignore */
    }
  }
  return { service: undefined, scope: undefined };
}

/** Compaction service, from whichever scope publishes it. */
function compactionService(ctx, agent) {
  return resolveService(ctx, "compaction", agent);
}

/** Look up one live Agent by id, tolerating a missing service. */
function liveAgent(ctx, id) {
  if (id === undefined) return undefined;
  try {
    return ctx.get("agents")?.get?.(id);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// context pressure (issue 1: saturation must be visible before re-waking)
// ---------------------------------------------------------------------------

/** Last durably routed provider/model for one session. */
function routedTarget(session) {
  try {
    const config = session?.requestHeader?.()?.config;
    if (typeof config?.provider === "string" && typeof config?.model === "string") {
      return { provider: config.provider, model: config.model };
    }
  } catch {
    /* ignore */
  }
  try {
    const total = Number(session?.seq ?? 0);
    for (let index = total - 1; index >= 0; index -= 1) {
      const event = session.eventAt(index);
      if (event?.type !== "request/header") continue;
      const config = event.data?.header?.config;
      if (typeof config?.provider === "string" && typeof config?.model === "string") {
        return { provider: config.provider, model: config.model };
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Read one persisted session through a short-lived handle. */
async function readPersistedSession(persistence, id, signal) {
  const handle = await persistence.open(id, "read", { signal });
  try {
    const { events } = await handle.read(0, undefined, { signal });
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events };
  } finally {
    await handle.close();
  }
}

/**
 * Build a detached (never-entered) replica of one unloaded child session so the
 * token meter can be pointed at it. Returns undefined when the session cannot
 * be read or restored — measurement is then reported as unknown instead of
 * guessed.
 */
async function detachedSession(ctx, id, signal) {
  const persistence = ctx.get("sessionPersistence");
  const sessions = ctx.get("sessions");
  if (persistence === undefined || sessions === undefined || typeof sessions.prepare !== "function") return undefined;
  try {
    if (typeof sessions.get === "function" && sessions.get(id) !== undefined) return undefined;
  } catch {
    /* the store lookup is advisory */
  }
  const stored = await readPersistedSession(persistence, id, signal);
  if (!Array.isArray(stored.events) || stored.events.length === 0) return undefined;
  if (stored.events.length > 40000) return undefined;
  // `eventState` routes through `Session.fromRestore(sessionId, seed, options.meta, …)`,
  // which validates `options.meta` as the *complete* session header — the
  // `prepare` path that fills a header from a partial `meta` is skipped in that
  // branch. A partial meta therefore fails with
  // `session header version must be 4, got undefined` (observed live). Reuse the
  // persisted header and only supply what a restored session needs.
  const persisted = stored.header !== null && typeof stored.header === "object" ? stored.header : {};
  const meta = {
    version: 4,
    id,
    createdAt: finite(persisted.createdAt) ?? Date.now(),
    isSeeded: persisted.isSeeded === true,
    ...(typeof persisted.cwd === "string" && persisted.cwd.length > 0 ? { cwd: persisted.cwd } : {}),
    ...(persisted.parentSession === undefined ? {} : { parentSession: persisted.parentSession }),
    ...(persisted.origin === undefined ? {} : { origin: persisted.origin }),
    ...(persisted.delegationDepth === undefined ? {} : { delegationDepth: persisted.delegationDepth }),
    ...(persisted.agentPreset === undefined ? {} : { agentPreset: persisted.agentPreset })
  };
  return sessions.prepare(id, {
    seed: stored.events,
    meta,
    inheritedEventCount: stored.inheritedEventCount,
    eventState: "detached"
  });
}

/** Route one provider/model pair to its context window, when the adapter knows it. */
async function contextWindowOf(ctx, target, signal, options) {
  const configured = finite(options?.defaultContextWindow);
  if (target === undefined) return configured;
  const llm = ctx.get("llm");
  if (llm === undefined || typeof llm.resolveModelInfo !== "function") return configured;
  try {
    const info = await llm.resolveModelInfo(target.provider, target.model, signal);
    const window = finite(info?.context?.contextWindow);
    return window !== undefined && window > 0 ? window : configured;
  } catch {
    return configured;
  }
}

/**
 * The binding pressure budget for one member: the tighter of the routed model
 * window and an explicitly declared per-member budget. A declared budget above
 * the window can never be reached, so it must not mask window pressure.
 */
function effectiveBudget(contextWindow, tokenBudget) {
  const candidates = [contextWindow, tokenBudget].filter((value) => value !== undefined && value > 0);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** Classify one measured token count against a window and an explicit budget. */
function saturationLevel(tokens, contextWindow, tokenBudget) {
  if (tokens === undefined || tokens <= 0) return "unknown";
  const budget = effectiveBudget(contextWindow, tokenBudget);
  if (budget !== undefined && budget > 0) {
    const ratio = tokens / budget;
    if (ratio >= RATIO_OVER) return "over";
    if (ratio >= RATIO_NEAR_SATURATED) return "near_saturated";
    if (ratio >= RATIO_WATCH) return "watch";
    return "ok";
  }
  if (tokens >= TOKENS_OVER) return "over";
  if (tokens >= TOKENS_NEAR_SATURATED) return "near_saturated";
  if (tokens >= TOKENS_WATCH) return "watch";
  return "ok";
}

/**
 * Measure one member's current request pressure.
 *
 * Live members are measured on their own session. Unloaded members are
 * measured on a detached replica of their persisted log, so a Lead can see
 * that a cold teammate is already full *before* waking it. Anything that
 * cannot be read is reported as unknown rather than estimated.
 */
async function measureMember(ctx, member, options, signal) {
  const live = liveAgent(ctx, member.id);
  let session = live?.session;
  let source = live === undefined ? "unloaded" : "live";
  if (session === undefined) {
    try {
      const detached = await detachedSession(ctx, member.id, signal);
      if (detached !== undefined) {
        session = detached;
        source = "persisted";
      }
    } catch (error) {
      return { known: false, source: "unreadable", detail: String(error?.message ?? error).slice(0, 200) };
    }
  }
  if (session === undefined) return { known: false, source };
  const meter = ctx.get("tokenMeter");
  if (meter === undefined || typeof meter.measure !== "function") return { known: false, source, detail: "tokenMeter unavailable" };
  let measurement;
  try {
    measurement = meter.measure(session);
  } catch (error) {
    return { known: false, source, detail: String(error?.message ?? error).slice(0, 200) };
  }
  const tokens = finite(measurement?.totalTokens);
  const target = routedTarget(session);
  const contextWindow = await contextWindowOf(ctx, target, signal, options);
  const tokenBudget = finite(member.tokenBudget);
  const budget = effectiveBudget(contextWindow, tokenBudget);
  return {
    known: tokens !== undefined,
    source,
    tokens: tokens ?? null,
    contextWindow: contextWindow ?? null,
    tokenBudget: tokenBudget !== undefined && tokenBudget > 0 ? tokenBudget : null,
    ratio: budget !== undefined && budget > 0 && tokens !== undefined ? round(tokens / budget) : null,
    remaining: budget !== undefined && budget > 0 && tokens !== undefined ? Math.max(0, Math.round(budget - tokens)) : null,
    level: saturationLevel(tokens, contextWindow, tokenBudget),
    routed: target ?? null
  };
}

// ---------------------------------------------------------------------------
// settlement notice ledger (issue 4: repeated closing messages)
// ---------------------------------------------------------------------------

/** Text blocks of one model-visible message, concatenated. */
function textOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Every runtime-owned settlement notice in one session log, newest last.
 *
 * The notice source carries `kind: "subagent-settled"`, the child session id
 * and the summary line, but **no activation identity** — so this ledger
 * groups by `(child, summary, closing-text digest)` and reports how often each
 * group repeats. Repeats from different activations are legitimate; repeats
 * with nothing in between are the redelivery symptom.
 */
function settlementLedger(session, limit) {
  const empty = { total: 0, unique: 0, repeats: [], recent: [] };
  if (session === undefined) return empty;
  const entries = [];
  let total = 0;
  try {
    total = Number(session.seq ?? 0);
  } catch {
    return empty;
  }
  for (let index = 0; index < total; index += 1) {
    let event;
    try {
      event = session.eventAt(index);
    } catch {
      continue;
    }
    if (event?.type !== "user/message") continue;
    const source = event.data?.source;
    if (source?.kind !== "subagent-settled") continue;
    const body = textOf(event.data);
    entries.push({
      seq: event.seq,
      child: source.senderSessionId ?? null,
      summary: source.summary ?? null,
      digest: digest(body),
      characters: body.length
    });
  }
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.child}|${entry.summary}|${entry.digest}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }
  const repeats = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    repeats.push({
      child: bucket[0].child,
      summary: bucket[0].summary,
      digest: bucket[0].digest,
      count: bucket.length,
      seqs: bucket.map((entry) => entry.seq)
    });
  }
  const recent = entries.slice(Math.max(0, entries.length - (limit ?? 10)));
  return { total: entries.length, unique: groups.size, repeats, recent };
}

// ---------------------------------------------------------------------------
// target resolution (issue 3: subagents were unreachable by name)
// ---------------------------------------------------------------------------

/** Looks like a durable session id rather than a member name. */
function looksLikeSessionId(value) {
  return /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-\d+|[0-9a-f]{16,})$/iu.test(String(value));
}

/**
 * Resolve one `target` argument to a delivery destination.
 *
 * Order: the Lead, a roster teammate by durable name, a roster teammate by
 * sidecar alias, a live child agent id, then a bare session-id shape. The last
 * two are what make non-roster continuable subagents steerable again.
 */
function resolveTarget(ctx, caller, membership, rows, target) {
  const wanted = String(target ?? "").trim();
  if (wanted.length === 0) throw new Error("target must be a non-empty teammate name, alias, or child session id");
  const store = readStore(membership.root.id);
  const aliases = new Map();
  for (const record of Object.values(store.members)) {
    if (typeof record?.alias === "string" && record.alias.length > 0) aliases.set(record.alias.toLowerCase(), record);
    if (Array.isArray(record?.formerNames)) {
      for (const former of record.formerNames) {
        if (typeof former === "string" && former.length > 0 && !aliases.has(former.toLowerCase())) aliases.set(former.toLowerCase(), record);
      }
    }
  }
  if (wanted.toLowerCase() === "lead") {
    return { kind: "lead", id: membership.root.id, coreName: "lead", alias: null, deleted: false, retired: false };
  }
  /** A tombstoned member is gone for good: refuse instead of half-addressing it. */
  const refuseIfDeleted = (coreName) => {
    const record = store.members[coreName];
    if (record?.deleted === true) {
      throw new Error(`teammate "${coreName}" was deleted (${record.deletedAt ?? "unknown time"}); deletion is irreversible — create a new member with team_member_add`);
    }
    return record;
  };
  for (const row of rows) {
    if (row.role !== "teammate") continue;
    if (row.name === wanted) {
      const record = refuseIfDeleted(row.name);
      return { kind: "teammate", id: row.id, coreName: row.name, alias: record?.alias ?? null, deleted: false, retired: record?.retired === true };
    }
  }
  for (const [alias, record] of aliases) {
    if (alias !== wanted.toLowerCase()) continue;
    if (record.deleted === true) refuseIfDeleted(record.coreName);
    const row = rows.find((candidate) => candidate.name === record.coreName);
    if (row !== undefined) return { kind: "teammate", id: row.id, coreName: row.name, alias: record.alias ?? null, deleted: false, retired: record.retired === true };
  }
  const live = liveAgent(ctx, wanted);
  if (live !== undefined) return { kind: "child", id: live.id, coreName: String(live.id), alias: null, deleted: false, retired: false };
  const rowById = rows.find((row) => row.id === wanted);
  if (rowById !== undefined) return { kind: rowById.role, id: rowById.id, coreName: rowById.name, alias: null, deleted: false, retired: false };
  if (looksLikeSessionId(wanted)) return { kind: "child", id: wanted, coreName: wanted, alias: null, deleted: false, retired: false };
  const known = rows.filter((row) => row.role === "teammate").map((row) => row.name).join(", ") || "(none)";
  throw new Error(`target "${wanted}" is not a teammate name, a teammate alias, or a child session id (known teammates: ${known})`);
}

/** Deliver one authored message to a resolved target. */
async function deliver(ctx, caller, resolved, text, signal) {
  const content = [{ type: "text", text }];
  if (resolved.kind === "lead" || resolved.kind === "teammate") {
    const service = teamService(ctx);
    if (service === undefined || typeof service.sendMessage !== "function") {
      throw new Error("Agent Teams service is not mounted; only child-session delivery is available");
    }
    if (resolved.id === caller.id) throw new Error("a member cannot send a message to itself");
    const result = await service.sendMessage(caller, { target: resolved.coreName, content, signal });
    return { channel: "team", messageId: result?.messageId ?? null, status: result?.status ?? null };
  }
  const { service: subagents } = resolveService(ctx, "subagents", caller);
  if (subagents === undefined || typeof subagents.sendMessage !== "function") {
    throw new Error("subagent service is not mounted; cannot reach a child session");
  }
  const messageId = await subagents.sendMessage(caller, resolved.id, content, { signal });
  return { channel: "subagent", messageId: messageId ?? null, status: null };
}

// ---------------------------------------------------------------------------
// tool definitions (plain registry definitions — no @deepseek-ai imports)
// ---------------------------------------------------------------------------

/** Build one registry-ready definition rendered as a single JSON text block. */
function defineConductorTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }]
    },
    async execute(args, exec) {
      assertArgumentShape(definition.name, definition.parameters, args);
      const value = await definition.run(args ?? {}, exec);
      return { text: `${JSON.stringify(value, null, 1)}\n` };
    }
  };
}

/** Argument validation for hand-authored schemas (the runtime does not do it). */
function assertArgumentShape(toolName, schema, args) {
  const problems = validateSubset(schema, args, "");
  if (problems.length > 0) throw new Error(`${toolName}: invalid arguments — ${problems.join("; ")}`);
}

/**
 * Validate a value against the enforced JSON-Schema subset. Deliberately
 * mirrors `dsh-tools`' own checker semantics: declarations are enforced, the
 * root parameter object stays open, and unknown keywords never appear here.
 */
function validateSubset(schema, value, path) {
  const problems = [];
  if (schema === null || typeof schema !== "object") return problems;
  const type = schema.type;
  if (typeof type === "string") {
    const ok = type === "string" ? typeof value === "string"
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
      : type === "integer" ? typeof value === "number" && Number.isInteger(value)
      : type === "boolean" ? typeof value === "boolean"
      : type === "null" ? value === null
      : type === "array" ? Array.isArray(value)
      : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : true;
    if (!ok) return [`${path || "args"} must be ${type}`];
  }
  if (Array.isArray(schema.required) && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) problems.push(`${childPath(path, key)} is required`);
    }
  }
  if (schema.properties !== null && typeof schema.properties === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue;
      problems.push(...validateSubset(propertySchema, value[key], childPath(path, key)));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) problems.push(`${childPath(path, key)} is not allowed`);
      }
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => problems.push(...validateSubset(schema.items, item, `${path}[${index}]`)));
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path || "args"} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join("/")}`);
  }
  return problems;
}

/** Join one nested argument path without a trailing separator. */
function childPath(base, key) {
  return base.length === 0 ? String(key) : `${base}.${key}`;
}

/** The four model-facing tools, built once per installed agent scope. */
function buildTools(ctx, options, state) {
  const overview = defineConductorTool({
    name: "team_overview",
    description:
      "One call for the whole Team: roster with aliases, descriptions, priorities and tags, each member's context pressure and saturation level, the member ceiling (used/max/free), and the settlement-notice ledger of this session. Check this before re-waking any teammate.",
    parameters: {
      type: "object",
      properties: {
        include_settlements: { type: "boolean", description: "Include the settlement-notice ledger. Defaults to true." },
        include_children: { type: "boolean", description: "Include live non-roster child agents as addressable targets. Defaults to true." }
      },
      additionalProperties: false
    },
    async run(args, exec) {
      const caller = callingAgent(exec.agent, "team_overview");
      const membership = requiredMembership(ctx, caller, "team_overview");
      const rows = memberRows(ctx, caller);
      const store = readStore(membership.root.id);
      const max = maxMembers(ctx);
      const members = [];
      for (const row of rows) {
        const record = row.role === "teammate" ? store.members[row.name] ?? {} : {};
        const measured = row.role === "teammate"
          ? await measureMember(ctx, { id: row.id, tokenBudget: record.tokenBudget }, options, signalOf(exec))
          : { known: true, source: "live", tokens: null, level: "unknown" };
        members.push({
          target: row.name,
          displayName: record.alias ?? row.name,
          alias: record.alias ?? null,
          formerNames: Array.isArray(record.formerNames) ? record.formerNames : [],
          role: row.role,
          status: row.status,
          description: record.description ?? row.description ?? null,
          originalDescription: row.description ?? null,
          context: row.context ?? null,
          provider: row.provider ?? null,
          model: row.model ?? null,
          priority: record.priority ?? null,
          tags: Array.isArray(record.tags) ? record.tags : [],
          retired: record.retired === true,
          deleted: record.deleted === true,
          deletedAt: record.deletedAt ?? null,
          availability: row.role !== "teammate"
            ? "lead"
            : record.deleted === true
              ? "deleted"
              : record.retired === true
                ? "retired"
                : row.status === "running"
                  ? "working"
                  : "idle-ready",
          comments: Array.isArray(record.notes) ? record.notes.slice(-3) : [],
          loaded: liveAgent(ctx, row.id) !== undefined,
          contextPressure: measureView(measured),
          diagnostics: Array.isArray(row.diagnostics) ? row.diagnostics : []
        });
      }
      const teammates = members.filter((member) => member.role === "teammate");
      const rosterIds = new Set(rows.map((row) => row.id));
      const liveChildren = listAgents(ctx).filter((agent) => {
        if (rosterIds.has(agent.id)) return false;
        try {
          // Only this Team's own children are addressable work; another
          // session's subagents belong to a different Lead.
          return agent.session?.header?.parentSession === membership.root.id;
        } catch {
          return false;
        }
      });
      const payload = {
        team: {
          root: membership.root.id,
          caller: { target: membership.name, role: membership.role },
          capacity: {
            used: teammates.length,
            max,
            free: Math.max(0, max - teammates.length),
            configured: finite(teamService(ctx)?.config?.maxMembers) ?? null,
            serving: teammates.filter((member) => !member.deleted).length,
            retired: teammates.filter((member) => member.retired && !member.deleted).length,
            deleted: teammates.filter((member) => member.deleted).length,
            failed: teammates.filter((member) => member.status === "failed" && !member.deleted).length,
            full: teammates.length >= max
          }
        },
        members,
        diagnostics: diagnostics(ctx, state, teammates, caller)
      };
      if (args.include_children !== false) {
        payload.children = liveChildren.map((agent) => childView(ctx, agent, membership));
      }
      if (args.include_settlements !== false) {
        payload.settlements = settlementLedger(liveAgent(ctx, caller.id)?.session, options.maxOverviewNotices);
      }
      payload.guard = {
        // Report what is actually installed: `settlementDedupe` is only true
        // when the wrapper is live on the activation registry.
        settlementDedupe: state.guardStatus === "active",
        settlementDedupeStatus: state.guardStatus ?? "unknown",
        suppressed: state.stats.suppressedNotices,
        blockDeletedTargets: state.deleteGuardStatus === "active",
        blockDeletedTargetsStatus: state.deleteGuardStatus ?? "unknown",
        blockedDeletedSends: state.stats.blockedDeletedSends
      };
      return payload;
    }
  });

  const memberEdit = defineConductorTool({
    name: "team_member_edit",
    description:
      "Edit one Team member: alias, rename, describe, priority, tags, token budget, re-brief, reassign (rename + take the next shared task + receive a fresh brief, so a FINISHED member is reused instead of a new one being created), retire/restore (release or re-arm a member), compact (shrink a saturated member's context) or interrupt. The durable upstream name is immutable — renaming happens in the orchestration layer and the previous name stays addressable. Lead-only for retire, rename/reassign and capacity-affecting actions.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Teammate durable name, conductor alias, former name, or child session id." },
        action: {
          type: "string",
          enum: ["alias", "rename", "describe", "priority", "tags", "budget", "rebrief", "reassign", "retire", "restore", "compact", "interrupt"],
          description: "The edit to apply."
        },
        value: { type: "string", description: "New alias / new conductor name (alias/rename/reassign) or description text (describe)." },
        message: { type: "string", description: "Self-contained brief (rebrief/reassign)." },
        tags: { type: "array", items: { type: "string" }, description: "Replacement tag list (action=tags)." },
        priority: { type: "integer", description: "Higher runs first (action=priority)." },
        token_budget: { type: "integer", description: "Per-member context budget in tokens; 0 clears it (action=budget)." },
        task_id: { type: "string", description: "Shared task to hand over (action=reassign); it is reassigned to this member before the brief is sent." },
        compact_first: { type: "boolean", description: "Shrink the member's context before sending the new brief (action=reassign). Defaults to false." }
      },
      required: ["target", "action"],
      additionalProperties: false
    },
    async run(args, exec) {
      const caller = callingAgent(exec.agent, "team_member_edit");
      const membership = requiredMembership(ctx, caller, "team_member_edit");
      const rows = memberRows(ctx, caller);
      const resolved = resolveTarget(ctx, caller, membership, rows, args.target);
      const rootId = membership.root.id;
      const effects = [];
      const warnings = [];
      let record;
      let taskUpdate = null;
      switch (args.action) {
        case "alias": {
          requireText(args.value, "value", "alias");
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({ ...current, coreName: resolved.coreName, alias: args.value.trim().slice(0, 64) }));
          effects.push(`alias resolved to "${record.alias}"`);
          break;
        }
        case "rename": {
          requireLead(membership, "rename");
          requireText(args.value, "value", "rename");
          record = renameMember(rootId, resolved.coreName, args.value);
          effects.push(`renamed to "${record.alias}" in the orchestration layer; the durable name stays "${resolved.coreName}" and the previous name(s) still resolve`);
          break;
        }
        case "reassign": {
          requireLead(membership, "reassign");
          if (typeof args.message !== "string" || args.message.trim().length === 0) {
            throw new Error("action=reassign requires message: the self-contained brief for the next task");
          }
          if (typeof args.value === "string" && args.value.trim().length > 0) {
            record = renameMember(rootId, resolved.coreName, args.value);
            effects.push(`renamed to "${record.alias}" for the next task`);
          }
          if (args.compact_first === true) {
            const live = liveAgent(ctx, resolved.id);
            const { service: compaction } = live === undefined ? { service: undefined } : compactionService(ctx, live);
            if (live === undefined) warnings.push("compact_first was requested but the member is not loaded; skipped");
            else if (compaction === undefined || typeof compaction.compactNow !== "function") warnings.push("compact_first was requested but compaction is not mounted in either scope; skipped");
            else {
              try {
                const result = await compaction.compactNow(live, signalOf(exec), `${PLUGIN_ID}:reassign`);
                effects.push(result === null ? "compact_first: no safe useful range" : "compact_first: context shrunk before the new brief");
              } catch (error) {
                warnings.push(`compact_first failed: ${messageOf(error)}`);
              }
            }
          }
          const taskId = typeof args.task_id === "string" && args.task_id.trim().length > 0 ? args.task_id.trim() : undefined;
          if (taskId !== undefined) {
            const service = teamService(ctx);
            if (service === undefined || typeof service.getTask !== "function" || typeof service.updateTask !== "function") {
              warnings.push("task hand-over skipped: the task board is unavailable");
            } else {
              try {
                const task = service.getTask(caller, taskId);
                const updated = await service.updateTask(caller, {
                  taskId,
                  expectedRevision: task.revision,
                  action: "reassign",
                  owner: resolved.coreName
                });
                taskUpdate = { id: taskId, revision: updated?.revision ?? null, ownerName: updated?.ownerName ?? resolved.coreName };
                effects.push(`shared task ${taskId} handed to "${resolved.coreName}" (revision ${updated?.revision ?? "?"})`);
              } catch (error) {
                warnings.push(`task hand-over failed: ${messageOf(error)}`);
              }
            }
          }
          const brief = String(args.message);
          const firstLine = brief.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
          const handoff = await deliver(ctx, caller, resolved, brief, signalOf(exec));
          effects.push(`next brief delivered over the ${handoff.channel} channel`);
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({
            ...current,
            coreName: resolved.coreName,
            retired: false,
            retiredAt: undefined,
            ...(firstLine.length === 0 ? {} : { description: firstLine.slice(0, 200) }),
            notes: pushNote(current.notes, `reassigned ${new Date().toISOString()}${taskId === undefined ? "" : ` → ${taskId}`}`)
          }));
          break;
        }
        case "describe": {
          requireText(args.value, "value", "describe");
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({ ...current, coreName: resolved.coreName, description: args.value.trim().slice(0, 2000) }));
          effects.push("working description updated");
          break;
        }
        case "priority": {
          const priority = finite(args.priority);
          if (priority === undefined || !Number.isInteger(priority)) throw new Error("action=priority requires an integer priority");
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({ ...current, coreName: resolved.coreName, priority }));
          effects.push(`priority set to ${priority}`);
          break;
        }
        case "tags": {
          if (!Array.isArray(args.tags)) throw new Error("action=tags requires a tags array");
          const tags = args.tags.map((tag) => String(tag).slice(0, 64)).slice(0, 32);
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({ ...current, coreName: resolved.coreName, tags }));
          effects.push(`tags set to [${tags.join(", ")}]`);
          break;
        }
        case "budget": {
          const budget = finite(args.token_budget);
          if (budget === undefined) throw new Error("action=budget requires token_budget; pass 0 to clear it");
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({
            ...current,
            coreName: resolved.coreName,
            tokenBudget: budget > 0 ? Math.round(budget) : undefined
          }));
          effects.push(budget > 0 ? `context budget set to ${Math.round(budget)} tokens` : "context budget cleared");
          break;
        }
        case "rebrief": {
          requireText(args.message, "message", "rebrief");
          const delivery = await deliver(ctx, caller, resolved, args.message, signalOf(exec));
          effects.push(`re-briefed over the ${delivery.channel} channel`);
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({
            ...current,
            coreName: resolved.coreName,
            notes: pushNote(current.notes, `re-briefed ${new Date().toISOString()}`)
          }));
          break;
        }
        case "retire": {
          requireLead(membership, "retire");
          if (resolved.kind !== "teammate") throw new Error("action=retire applies to a roster teammate");
          const service = teamService(ctx);
          const live = liveAgent(ctx, resolved.id);
          if (live !== undefined && live.status === "running" && typeof service?.interrupt === "function") {
            try {
              await service.interrupt(caller, resolved.coreName);
              effects.push("current turn interrupted");
            } catch (error) {
              warnings.push(`interrupt failed: ${messageOf(error)}`);
            }
          }
          const roster = service?.roster;
          if (roster !== undefined && typeof roster.stopTeammates === "function") {
            try {
              await withTimeout(roster.stopTeammates(membership.root, [resolved.id]), 15000);
              effects.push("live activation released (context freed)");
            } catch (error) {
              warnings.push(`releasing the live activation failed: ${messageOf(error)}`);
            }
          } else {
            warnings.push("roster.stopTeammates unavailable; only the retired flag was set");
          }
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({
            ...current,
            coreName: resolved.coreName,
            retired: true,
            retiredAt: new Date().toISOString()
          }));
          effects.push("member marked retired (roster rows are immutable upstream; use team_capacity_set for more room)");
          break;
        }
        case "restore": {
          requireLead(membership, "restore");
          record = updateMemberRecord(rootId, resolved.coreName, (current) => ({
            ...current,
            coreName: resolved.coreName,
            retired: false,
            retiredAt: undefined
          }));
          effects.push("member re-armed; the next message cold-resumes it");
          break;
        }
        case "compact": {
          // Compacting *another* member's context is a capacity-affecting
          // operation; compacting your own session is not.
          if (resolved.id !== caller.id) requireLead(membership, "compact");
          const live = liveAgent(ctx, resolved.id);
          if (live === undefined) {
            warnings.push("member is not loaded; send a message first (action=rebrief) so its session is live, then compact");
          } else {
            const { service: compaction, scope: compactionScope } = compactionService(ctx, live);
            if (compaction === undefined || typeof compaction.compactNow !== "function") {
              warnings.push("compaction service is not mounted in either scope; cannot compact");
            } else {
              const before = await measureMember(ctx, { id: resolved.id }, options, signalOf(exec));
              try {
                const result = await compaction.compactNow(live, signalOf(exec), `${PLUGIN_ID}:manual`);
                const after = await measureMember(ctx, { id: resolved.id }, options, signalOf(exec));
                effects.push(result === null ? "compaction found no safe useful range" : "compaction applied");
                effects.push(`pressure ${describe(before.tokens)} → ${describe(after.tokens)} tokens`);
                if (compactionScope !== undefined) effects.push(`compaction resolved in the ${compactionScope} scope`);
              } catch (error) {
                warnings.push(`compaction failed: ${messageOf(error)}`);
              }
            }
          }
          break;
        }
        case "interrupt": {
          if (resolved.id !== caller.id) requireLead(membership, "interrupt");
          const service = teamService(ctx);
          if (resolved.kind !== "teammate" || typeof service?.interrupt !== "function") {
            warnings.push("interrupt requires a roster teammate and the Agent Teams service");
          } else {
            const result = await service.interrupt(caller, resolved.coreName);
            effects.push(`interrupted (was ${result?.previousStatus ?? "unknown"})`);
          }
          break;
        }
        default:
          throw new Error(`unsupported action "${String(args.action)}"`);
      }
      const refreshed = memberRows(ctx, caller).find((row) => row.id === resolved.id);
      return {
        target: { requested: String(args.target), resolved },
        action: String(args.action),
        member: refreshed === undefined ? null : {
          target: refreshed.name,
          role: refreshed.role,
          status: refreshed.status,
          alias: (readStore(rootId).members[refreshed.name] ?? {}).alias ?? null,
          deleted: (readStore(rootId).members[refreshed.name] ?? {}).deleted === true
        },
        record: record ?? readStore(rootId).members[resolved.coreName] ?? null,
        task: taskUpdate,
        effects,
        warnings
      };
    }
  });

  const capacitySet = defineConductorTool({
    name: "team_capacity_set",
    description:
      "Change the Team member ceiling at runtime. The shipped team bundle caps a Team at 8 members and upstream never reuses a name, so a full Team with no removal tool deadlocks; raise the ceiling here instead of retrying a failing spawn. Lead only.",
    parameters: {
      type: "object",
      properties: {
        max_members: { type: "integer", description: "New ceiling, at least 1." },
        reason: { type: "string", description: "Optional note recorded with the change." }
      },
      required: ["max_members"],
      additionalProperties: false
    },
    async run(args, exec) {
      const caller = callingAgent(exec.agent, "team_capacity_set");
      const membership = requiredMembership(ctx, caller, "team_capacity_set");
      requireLead(membership, "team_capacity_set");
      const next = finite(args.max_members);
      if (next === undefined || !Number.isInteger(next) || next < 1) throw new Error("max_members must be an integer >= 1");
      const service = teamService(ctx);
      const before = maxMembers(ctx);
      const roster = service?.roster;
      if (roster === undefined) throw new Error("the Agent Teams roster is not available; raising the ceiling needs the team bundle mounted");
      const used = memberRows(ctx, caller).filter((row) => row.role === "teammate").length;
      if (next < used) throw new Error(`cannot lower the ceiling to ${next}: ${used} member slots are already taken (names are never reused upstream)`);
      roster.maxMembers = next;
      const store = readStore(membership.root.id);
      store.capacity = { observedMax: next, reason: typeof args.reason === "string" ? args.reason.slice(0, 200) : undefined, changedAt: new Date().toISOString() };
      writeStore(membership.root.id, store);
      return {
        before,
        after: finite(roster.maxMembers) ?? next,
        used,
        free: Math.max(0, next - used),
        note: "applies to this process only; the profile's configured maxMembers returns on restart"
      };
    }
  });

  const message = defineConductorTool({
    name: "team_message",
    description:
      "Send one durable message to a Team member by name or alias, or steer a non-roster continuable subagent directly by its child session id — the channel the team-scoped send_message cannot reach.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Teammate name, teammate alias, or child session id." },
        message: { type: "string", description: "Self-contained message for the target." }
      },
      required: ["target", "message"],
      additionalProperties: false
    },
    async run(args, exec) {
      const caller = callingAgent(exec.agent, "team_message");
      const membership = requiredMembership(ctx, caller, "team_message");
      requireText(args.message, "message", "team_message");
      const rows = memberRows(ctx, caller);
      const resolved = resolveTarget(ctx, caller, membership, rows, args.target);
      const delivery = await deliver(ctx, caller, resolved, args.message, signalOf(exec));
      return { target: resolved, delivery };
    }
  });

  const memberAdd = defineConductorTool({
    name: "team_member_add",
    description:
      "Create one durable teammate through the conductor, with optional alias/priority/tags recorded for later addressing. When the Team is full it raises the member ceiling itself (auto_capacity), so this tool never trips the upstream TEAM_MEMBER_LIMIT error. Lead only.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique lower-kebab-case teammate name. Names are never reusable upstream." },
        description: { type: "string", description: "Short description of the delegated responsibility." },
        brief: { type: "string", description: "Complete, self-contained initial task for the teammate." },
        context: { type: "string", enum: ["fresh", "fork"], description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh." },
        alias: { type: "string", description: "Optional conductor alias used by team_message and team_member_edit." },
        priority: { type: "integer", description: "Optional orchestration priority; higher runs first." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags for orchestration." },
        auto_capacity: { type: "boolean", description: "Raise the ceiling by one when the Team is full. Defaults to true." }
      },
      required: ["name", "description", "brief"],
      additionalProperties: false
    },
    async run(args, exec) {
      const caller = callingAgent(exec.agent, "team_member_add");
      const membership = requiredMembership(ctx, caller, "team_member_add");
      requireLead(membership, "team_member_add");
      const service = teamService(ctx);
      if (service === undefined || typeof service.spawnTeammate !== "function") {
        throw new Error("the Agent Teams service is not mounted; cannot add a member");
      }
      requireText(args.name, "name", "team_member_add");
      requireText(args.description, "description", "team_member_add");
      requireText(args.brief, "brief", "team_member_add");
      const effects = [];
      const warnings = [];
      const used = memberRows(ctx, caller).filter((row) => row.role === "teammate").length;
      const max = maxMembers(ctx);
      if (used >= max) {
        if (args.auto_capacity === false) {
          throw new Error(`the Team is full (${used}/${max}); call team_capacity_set first or leave auto_capacity enabled`);
        }
        const raised = raiseCeiling(ctx, membership, 1, `auto capacity for adding ${String(args.name).trim()}`);
        effects.push(`member ceiling raised ${raised.before} → ${raised.after} to make room`);
      }
      const context = args.context === "fork" ? "fork" : "fresh";
      const created = await service.spawnTeammate(caller, {
        name: String(args.name).trim(),
        description: String(args.description).trim().slice(0, 200),
        prompt: [{ type: "text", text: String(args.brief) }],
        context,
        provider: context === "fork" ? options.forkProvider : options.freshProvider,
        signal: signalOf(exec)
      });
      const coreName = created?.member?.name ?? String(args.name).trim();
      const priority = finite(args.priority);
      const record = updateMemberRecord(membership.root.id, coreName, (current) => ({
        ...current,
        coreName,
        ...(typeof args.alias === "string" && args.alias.trim().length > 0 ? { alias: args.alias.trim().slice(0, 64) } : {}),
        ...(priority === undefined ? {} : { priority: Math.round(priority) }),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map((tag) => String(tag).slice(0, 64)).slice(0, 32) } : {}),
        deleted: false,
        retired: false,
        notes: pushNote(current.notes, `added ${new Date().toISOString()}`)
      }));
      return {
        member: { target: coreName, role: "teammate", status: created?.member?.status ?? null, context },
        record,
        effects,
        warnings
      };
    }
  });

  const memberDelete = defineConductorTool({
    name: "team_member_delete",
    description:
      "Permanently delete one teammate: interrupt it, release its live activation, write a conductor tombstone, refuse every later message to that name from any caller, and raise the ceiling by one so a replacement fits. The upstream roster record cannot be removed or rewritten — its projection only allows provisioning -> active/failed — so the record stays visible upstream as inactive; sealing is only possible while a member is still provisioning. Irreversible. Lead only.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Teammate durable name or conductor alias." },
        reason: { type: "string", description: "Optional note recorded on the tombstone." },
        seal_kernel: { type: "boolean", description: "Also seal the upstream roster record into its terminal phase. Defaults to true." },
        auto_capacity: { type: "boolean", description: "Raise the ceiling by one so a replacement fits. Defaults to true." }
      },
      required: ["target"],
      additionalProperties: false
    },
    async run(args, exec) {
      const caller = callingAgent(exec.agent, "team_member_delete");
      const membership = requiredMembership(ctx, caller, "team_member_delete");
      requireLead(membership, "team_member_delete");
      const rows = memberRows(ctx, caller);
      const resolved = resolveTarget(ctx, caller, membership, rows, args.target);
      if (resolved.kind !== "teammate") {
        throw new Error("team_member_delete applies to a roster teammate; a non-roster child agent has no roster record to delete");
      }
      const service = teamService(ctx);
      const effects = [];
      const warnings = [];
      const live = liveAgent(ctx, resolved.id);
      if (live !== undefined && live.status === "running" && typeof service?.interrupt === "function") {
        try {
          await service.interrupt(caller, resolved.coreName);
          effects.push("current turn interrupted");
        } catch (error) {
          warnings.push(`interrupt failed: ${messageOf(error)}`);
        }
      }
      const roster = service?.roster;
      if (roster !== undefined && typeof roster.stopTeammates === "function") {
        try {
          await withTimeout(roster.stopTeammates(membership.root, [resolved.id]), 15000);
          effects.push("live activation released");
        } catch (error) {
          warnings.push(`releasing the live activation failed: ${messageOf(error)}`);
        }
      } else {
        warnings.push("roster.stopTeammates is unavailable; the member may stay resident");
      }
      updateMemberRecord(membership.root.id, resolved.coreName, (current) => ({
        ...current,
        coreName: resolved.coreName,
        deleted: true,
        deletedAt: new Date().toISOString(),
        retired: true,
        deleteReason: typeof args.reason === "string" ? args.reason.slice(0, 200) : undefined
      }));
      effects.push("conductor tombstone written");
      let seal = "skipped";
      if (args.seal_kernel !== false) {
        try {
          seal = await sealMemberInKernel(ctx, membership, resolved.id, "deleted by dsh-team-conductor");
        } catch (error) {
          seal = "failed";
          warnings.push(`sealing the roster record failed: ${messageOf(error)}`);
        }
      }
      effects.push(`upstream roster record: ${sealNote(seal)}`);
      const capacity = args.auto_capacity === false ? null : raiseCeiling(ctx, membership, 1, `auto capacity for deleting ${resolved.coreName}`);
      if (capacity !== null) effects.push(`member ceiling raised ${capacity.before} → ${capacity.after} so a replacement fits`);
      return {
        deleted: { target: resolved.coreName, id: resolved.id, seal, upstreamRecordRemoved: false },
        capacity,
        effects,
        warnings,
        note:
          seal === "sealed-provisioning"
            ? "irreversible: the record is sealed; upstream never reuses a name"
            : "irreversible and *conductor-level*: the upstream roster is an append-only log whose projection forbids rewriting an active record, so it is still listed upstream as inactive — the tombstone plus the message guard are what make the deletion effective, and the ceiling was raised so a replacement fits"
      };
    }
  });

  const built = [overview, memberEdit, capacitySet, message, memberAdd, memberDelete];
  for (const tool of built) {
    const rawExecute = tool.execute;
    tool.execute = async (args, exec) => {
      try {
        ensureGuard(ctx, state, exec?.agent);
      } catch {
        /* the guard must never block a tool call */
      }
      try {
        ensureDeleteGuard(ctx, state, exec?.agent);
      } catch {
        /* the guard must never block a tool call */
      }
      if (options.verboseLogging === true) {
        ctx.logger?.info?.(`[${PLUGIN_ID}] ${tool.name} by "${exec?.agent?.id ?? "unknown"}" args=${JSON.stringify(args ?? {}).slice(0, 300)}`);
      }
      return rawExecute(args, exec);
    };
  }
  return built;
}

/**
 * Raise the live roster ceiling by `delta` slots.
 *
 * `TeamRoster.maxMembers` is a plain writable field, and the spawn admission
 * check reads it directly, so this is the whole mechanism behind capacity
 * control at runtime.
 */
function raiseCeiling(ctx, membership, delta, reason) {
  const service = teamService(ctx);
  const roster = service?.roster;
  const before = maxMembers(ctx);
  const after = Math.max(1, before + delta);
  if (roster === undefined) return { before, after: before, applied: false, detail: "the roster is not available" };
  roster.maxMembers = after;
  const store = readStore(membership.root.id);
  store.capacity = { ...(store.capacity ?? {}), observedMax: after, reason, changedAt: new Date().toISOString() };
  writeStore(membership.root.id, store);
  return { before, after: finite(roster.maxMembers) ?? after, applied: true };
}

/**
 * Try to seal one roster member's upstream record.
 *
 * The persisted roster is an append-only replay log, and the **projection
 * itself** rejects every transition other than `provisioning -> active|failed`
 * (`@deepseek-ai/dsh-experimental-agent-team/lib/types/projection.js:196-203`,
 * mirrored by `lib/invariant.js:339-344`). Consequences:
 *
 *   - a `provisioning` member can legally be sealed to `failed` — that is the
 *     very edge the roster's own settlement writes, and its creator then sees
 *     the settled phase and stops without appending again
 *     (`TeamRoster.settleProvisioning` returns early on a non-provisioning
 *     record), so this cannot race into an illegal append;
 *   - an `active` (or already `failed`) record **cannot be changed at all**.
 *     Attempting it would append an event the projection then rejects, which
 *     poisons every later `journal.state()` read and breaks the whole Team
 *     surface for the rest of the session.
 *
 * This function therefore never attempts an illegal append; it reports the
 * exact reason instead, and `team_member_delete` documents it.
 */
async function sealMemberInKernel(ctx, membership, memberId, reason) {
  const service = teamService(ctx);
  const journal = service?.journal;
  if (journal === undefined || typeof journal.transact !== "function" || typeof journal.appendAndFlush !== "function") return "journal-unavailable";
  const root = membership.root;
  return await journal.transact(root.id, async () => {
    const current = journal.state(root).members.find((member) => member.id === memberId);
    if (current === undefined) return "not-in-roster";
    if (current.phase !== "provisioning") return `immutable-${current.phase}`;
    await journal.appendAndFlush(root, "team/member", {
      version: 2,
      teamId: root.id,
      member: { ...current, phase: "failed", error: reason }
    });
    return "sealed-provisioning";
  });
}

/**
 * Refuse to deliver a Team message to a tombstoned member.
 *
 * `team_member_delete` cannot remove or rewrite the upstream roster record (the
 * projection forbids it), so the kernel's own `send_message` would happily
 * cold-resume a deleted teammate and burn tokens on it. This guard closes that
 * hole for every caller in the process — it is the same additive, reversible
 * wrapper shape as the settlement guard.
 *
 * @returns the refusal message, or undefined when the target is fine.
 */
function blockedTarget(ctx, caller, request) {
  try {
    const membership = membershipOf(ctx, caller);
    if (membership === undefined) return undefined;
    const target = typeof request?.target === "string" ? request.target.trim() : "";
    if (target.length === 0 || target.toLowerCase() === "lead") return undefined;
    const record = readStore(membership.root.id).members[target];
    if (record?.deleted !== true) return undefined;
    return `teammate "${target}" was deleted by dsh-team-conductor (${record.deletedAt ?? "unknown time"}); the message was not delivered. The upstream roster record cannot be removed or renamed, so create a replacement with team_member_add.`;
  } catch {
    /* a guard must never break ordinary messaging */
    return undefined;
  }
}

/** Install (idempotently) the deleted-target guard on the Team service. */
function ensureDeleteGuard(ctx, state, agent) {
  if (state.options.blockDeletedTargets !== true) {
    state.deleteGuardStatus = "disabled";
    return state.deleteGuardStatus;
  }
  if (state.deleteGuard !== undefined) {
    state.deleteGuardStatus = "active";
    return state.deleteGuardStatus;
  }
  const found = resolveService(ctx, "agentTeams", agent);
  const service = found.service;
  if (service === undefined) {
    state.deleteGuardStatus = "pending";
    return state.deleteGuardStatus;
  }
  try {
    const wrapped = wrapMethodOnce(service, "sendMessage", (original) => async function sendMessageRefusingDeleted(caller, request) {
      const refusal = blockedTarget(ctx, caller, request);
      if (refusal !== undefined) {
        state.stats.blockedDeletedSends += 1;
        throw new Error(refusal);
      }
      return original.apply(this, [caller, request]);
    });
    if (wrapped === undefined) {
      state.deleteGuardStatus = "unsupported";
      return state.deleteGuardStatus;
    }
    state.deleteGuard = { owner: service, scope: found.scope, wrapper: wrapped.wrapper, original: wrapped.original };
    state.deleteGuardStatus = "active";
  } catch (error) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] deleted-target guard was not installed: ${messageOf(error)}`);
    state.deleteGuardStatus = "failed";
  }
  return state.deleteGuardStatus;
}

/** Remove the deleted-target guard (plugin disposal only). */
function removeDeleteGuard(state) {
  if (state.deleteGuard === undefined) return;
  try {
    const owner = state.deleteGuard.owner;
    if (isOurWrapper(owner?.sendMessage) && typeof state.deleteGuard.original === "function") {
      owner.sendMessage = state.deleteGuard.original;
    }
  } catch {
    /* best effort */
  }
  state.deleteGuard = undefined;
  state.deleteGuardStatus = "removed";
}

/**
 * Rename one member in the orchestration layer.
 *
 * The durable upstream name is immutable: the roster projection rejects any
 * `team/member` event where `prior.name !== member.name` ("changed immutable
 * identity fields", `lib/types/projection.js:196-201`). A rename therefore
 * assigns a new conductor alias, records every earlier name, and keeps
 * resolving through them — so a finished member can be renamed onto its next
 * shared task without losing any addressing the Lead already used.
 */
function renameMember(rootId, coreName, nextName) {
  const wanted = String(nextName ?? "").trim();
  if (wanted.length === 0) throw new Error("the new name must be non-empty");
  if (wanted.length > 64) throw new Error("the new name must be at most 64 characters");
  if (wanted === coreName) throw new Error(`"${wanted}" is already this member's durable name`);
  const store = readStore(rootId);
  for (const [key, record] of Object.entries(store.members)) {
    if (key === coreName) continue;
    if (key === wanted) throw new Error(`the name "${wanted}" is another member's durable name, and durable names are never reusable`);
    if (record?.alias === wanted) throw new Error(`the name "${wanted}" is already this Team's alias for "${key}"`);
    if (Array.isArray(record?.formerNames) && record.formerNames.includes(wanted)) throw new Error(`the name "${wanted}" was used before by "${key}"`);
  }
  return updateMemberRecord(rootId, coreName, (current) => {
    const previous = typeof current.alias === "string" && current.alias.length > 0 ? current.alias : coreName;
    const formerNames = [...new Set([...(Array.isArray(current.formerNames) ? current.formerNames : []), previous])].filter((name) => name !== wanted);
    return { ...current, coreName, alias: wanted, formerNames, renamedAt: new Date().toISOString() };
  });
}

/** Human wording for one sealing outcome. */
function sealNote(seal) {
  switch (seal) {
    case "sealed-provisioning":
      return "sealed to failed while the member was still provisioning (the only legal terminal edge)";
    case "skipped":
      return "left untouched (seal_kernel: false)";
    case "journal-unavailable":
      return "journal unavailable; nothing was written upstream";
    case "not-in-roster":
      return "no upstream record was found";
    default:
      return seal.startsWith("immutable-")
        ? `record is ${seal.slice("immutable-".length)} and the upstream projection forbids rewriting it (only provisioning -> active|failed is legal); it stays listed upstream, so the tombstone and the message guard are what make the deletion effective`
        : seal;
  }
}

/** Model-facing view of one measurement (never exposes internals). */
function measureView(measured) {
  return {
    known: measured.known === true,
    source: measured.source ?? null,
    tokens: measured.tokens ?? null,
    contextWindow: measured.contextWindow ?? null,
    tokenBudget: measured.tokenBudget ?? null,
    ratio: measured.ratio ?? null,
    remaining: measured.remaining ?? null,
    level: measured.level ?? "unknown",
    ...(measured.detail === undefined ? {} : { detail: measured.detail })
  };
}

/** Non-roster child agents addressable by id. */
function childView(ctx, agent, membership) {
  let parent = undefined;
  try {
    parent = agent.session?.header?.parentSession ?? undefined;
  } catch {
    parent = undefined;
  }
  return {
    id: agent.id,
    parent,
    status: agent.status === "running" ? "running" : "inactive",
    sameTeam: parent === membership.root.id,
    model: safeModel(agent)
  };
}

/** One agent's routed model, if it exposes one. */
function safeModel(agent) {
  try {
    const header = agent.session?.requestHeader?.();
    if (header?.config?.model !== undefined) return header.config.model;
  } catch {
    /* ignore */
  }
  try {
    return agent.options?.model ?? null;
  } catch {
    return null;
  }
}

/** Cross-cutting diagnostics shown by `team_overview`. */
function diagnostics(ctx, state, teammates, caller) {
  const notes = [];
  const service = teamService(ctx);
  if (service === undefined) notes.push("Agent Teams service is not mounted: roster, capacity and team messaging are unavailable.");
  if (resolveService(ctx, "tokenMeter", caller).service === undefined) notes.push("tokenMeter is not mounted: context pressure is reported as unknown.");
  if (compactionService(ctx, caller).service === undefined) notes.push("compaction is not mounted in either scope: action=compact cannot run.");
  const nearSaturated = teammates.filter((member) => member.contextPressure?.known && (member.contextPressure.level === "near_saturated" || member.contextPressure.level === "over"));
  for (const member of nearSaturated) {
    notes.push(
      `"${member.target}" is ${member.contextPressure.level} at ${member.contextPressure.tokens} tokens: compact it (team_member_edit action=compact) or hand the remaining work to a fresh subagent instead of re-waking it.`
    );
  }
  const max = maxMembers(ctx);
  if (teammates.length >= max) {
    notes.push(`The Team is full (${teammates.length}/${max}). team_member_add raises the ceiling itself; team_member_delete frees a tombstoned slot and team_capacity_set raises it directly.`);
  }
  const deleted = teammates.filter((member) => member.deleted);
  if (deleted.length > 0) {
    notes.push(`${deleted.length} deleted member(s) still occupy a roster record (upstream never reuses a name): ${deleted.map((member) => member.target).join(", ")}. Use team_member_add for replacements.`);
  }
  const reusable = teammates.filter((member) => member.availability === "idle-ready");
  if (reusable.length > 0) {
    notes.push(
      `${reusable.length} member(s) are idle and reusable: ${reusable.map((member) => member.displayName).join(", ")}. ` +
        "A finished member does not have to be replaced — call team_member_edit(action=reassign) to rename it onto the next shared task (optionally task_id + compact_first) instead of spending a new roster slot."
    );
  }
  if (state.stats.suppressedNotices > 0) notes.push(`${state.stats.suppressedNotices} duplicate settlement notice(s) were suppressed by the conductor guard.`);
  if (state.stats.blockedDeletedSends > 0) notes.push(`${state.stats.blockedDeletedSends} message(s) to deleted members were refused by the conductor guard.`);
  return notes;
}

/** Push one note onto a bounded note list. */
function pushNote(notes, note) {
  const list = Array.isArray(notes) ? [...notes] : [];
  list.push(note);
  return list.slice(-10);
}

/** Extract a message string from an unknown error. */
function messageOf(error) {
  return String(error?.message ?? error).slice(0, 300);
}

/** `null`-safe token text for effect lines. */
function describe(tokens) {
  return tokens === undefined || tokens === null ? "unknown" : String(tokens);
}

/** Await one promise with a hard timeout so a tool call cannot hang. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      if (typeof timer?.unref === "function") timer.unref();
    })
  ]);
}

/** Surrogate signal for callers that ran without a cancellation scope. */
const NEVER_ABORTED = new AbortController().signal;

/** The execution's cancellation signal, or a never-aborting surrogate. */
function signalOf(exec) {
  const signal = exec?.signal;
  return signal !== undefined && typeof signal.throwIfAborted === "function" ? signal : NEVER_ABORTED;
}

/** Require a non-empty string argument. */
function requireText(value, field, tool) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${tool}: ${field} must be a non-empty string`);
  return value;
}

/** Require the calling agent supplied by tool discovery. */
function callingAgent(agent, tool) {
  if (agent === undefined) throw new Error(`${tool} requires a calling Agent`);
  return agent;
}

/** Require a resolvable Team membership for the caller. */
function requiredMembership(ctx, caller, tool) {
  const membership = membershipOf(ctx, caller);
  if (membership === undefined) throw new Error(`${tool} is available only to a live Team member`);
  return membership;
}

/** Lead-only gate for mutating actions. */
function requireLead(membership, action) {
  if (membership.role !== "lead") throw new Error(`${action} is Lead-only`);
}

// ---------------------------------------------------------------------------
// the settlement-notice guard (issue 4)
// ---------------------------------------------------------------------------

/**
 * Suppress a second settlement notice for the *same* Activation object.
 *
 * The notice is produced by `ContinuableActivationRegistry.notifySettlement`
 * — a method on the **activation registry**, not on the `subagents` service
 * (`@deepseek-ai/dsh-subagent/lib/index.js:1254` defines it; `:1248` is its
 * only internal call site). The live path is
 * `ctx.subagents.continuations.activations.notifySettlement`
 * (`SubagentRuntime.continuations` at `:2826/:2842`, its `activations` field at
 * `:1662`). Wrapping `subagents.notifySettlement` — the obvious-looking
 * target — silently does nothing on a real kernel, which is exactly the kind
 * of "reported active but never fired" bug this guard must not have.
 *
 * Two more traps this implementation avoids:
 *
 *   - `ctx.get("subagents")` is a cordis Proxy. `Object.defineProperty` on it
 *     lands on the real instance (no trap), but a `readback !== wrapper` check
 *     always fails because the Proxy's `get` re-wraps the function value. So
 *     success is decided by the descriptor on the *owning object* and by a
 *     marker property on the wrapper, never by reference equality.
 *   - The wrapper is marked, so a second attempt is idempotent even through a
 *     Proxy, instead of stacking one more layer per tool call.
 */
const GUARD_MARK = "__dshTeamConductorGuard";

/** The wrapper created by this plugin, if `value` is one of ours. */
function isOurWrapper(value) {
  return typeof value === "function" && value[GUARD_MARK] === PLUGIN_ID;
}

/**
 * Locate the activation registry that owns `notifySettlement`.
 * @returns the owning object plus a scope label, or undefined.
 */
function resolveActivationRegistry(ctx, agent) {
  const found = resolveService(ctx, "subagents", agent);
  const service = found.service;
  if (service === undefined) return undefined;
  const candidates = [
    ["subagents.continuations.activations", service.continuations?.activations],
    ["subagents.activations", service.activations]
  ];
  for (const [scope, registry] of candidates) {
    if (registry !== undefined && registry !== null && typeof registry.notifySettlement === "function") {
      return { registry, scope };
    }
  }
  return undefined;
}

/**
 * Wrap one method once, in place, and return the wrapper (or undefined).
 *
 * Success is judged from the descriptor actually installed on `owner`, so a
 * Proxy readback cannot produce a false negative.
 */
function wrapMethodOnce(owner, methodName, makeWrapper) {
  const current = owner[methodName];
  if (typeof current !== "function") return undefined;
  if (isOurWrapper(current)) return { wrapper: current, original: undefined, alreadyInstalled: true };
  const wrapper = makeWrapper(current);
  wrapper[GUARD_MARK] = PLUGIN_ID;
  try {
    Object.defineProperty(owner, methodName, { value: wrapper, writable: true, configurable: true, enumerable: false });
  } catch {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
  return descriptor?.value === wrapper ? { wrapper, original: current, alreadyInstalled: false } : undefined;
}

/** Install (idempotently) the settlement-notice guard. */
function ensureGuard(ctx, state, agent) {
  if (state.options.dedupeSettlementNotices !== true) {
    state.guardStatus = "disabled";
    return state.guardStatus;
  }
  if (state.guard !== undefined) {
    state.guardStatus = "active";
    return state.guardStatus;
  }
  const target = resolveActivationRegistry(ctx, agent);
  if (target === undefined) {
    state.guardStatus = resolveService(ctx, "subagents", agent).service === undefined ? "pending" : "unsupported";
    return state.guardStatus;
  }
  try {
    const seen = new WeakSet();
    const wrapped = wrapMethodOnce(target.registry, "notifySettlement", (original) => function notifySettlementOnce(activation, terminal) {
      try {
        if (activation !== null && typeof activation === "object") {
          if (seen.has(activation)) {
            state.stats.suppressedNotices += 1;
            return undefined;
          }
          seen.add(activation);
        }
      } catch {
        /* never let the guard itself break settlement */
      }
      return original.apply(this, [activation, terminal]);
    });
    if (wrapped === undefined) {
      state.guardStatus = "failed";
      return state.guardStatus;
    }
    state.guard = { owner: target.registry, scope: target.scope, wrapper: wrapped.wrapper, original: wrapped.original };
    state.guardStatus = "active";
  } catch (error) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] settlement guard was not installed: ${messageOf(error)}`);
    state.guardStatus = "failed";
  }
  return state.guardStatus;
}

/** Remove the guard (only used by the plugin's own disposal path). */
function removeSettlementGuard(ctx, state) {
  if (state.guard === undefined) return;
  try {
    const owner = state.guard.owner;
    if (isOurWrapper(owner?.notifySettlement) && typeof state.guard.original === "function") {
      owner.notifySettlement = state.guard.original;
    }
  } catch {
    /* best effort */
  }
  state.guard = undefined;
  state.guardStatus = "removed";
}

// ---------------------------------------------------------------------------
// the injected policy (issues 3, 5, 6 + the operating discipline for 1/2/4)
// ---------------------------------------------------------------------------

/** Model-facing guidance, injected into every Team member's prompt. */
function policyText() {
  return [
    "Team 编排由 dsh-team-conductor 提供统一入口；别靠猜状态，先看再动。",
    "",
    "team_overview：一次拿到 roster（别名/职责/优先级/标签/是否已退休）、每个成员的上下文占用与饱和等级、容量（已用/上限/剩余）、以及本会话的 subagent 结算通知账本。",
    "续用任何 teammate 之前先看它：标了 near_saturated / over 的成员不要再反复唤醒——先 team_member_edit(action=compact) 压缩其上下文，或把剩余工作交给一个全新 subagent。同一 child 且摘要与正文哈希相同的结算通知按一条计，不要当成新一轮完成。",
    "",
    "team_member_edit：编辑成员（alias/rename/describe/priority/tags/budget/rebrief/reassign/retire/restore/compact/interrupt）。retire 是可逆的软下线：标记成员并释放其运行激活。",
    "成员干完一段活不要急着新建：先 team_task_list 找下一段可领的共享任务，再 team_member_edit(action=reassign, target=该成员, value=新名字, message=新简报, task_id=任务号, compact_first=true) —— 一次调用完成「改名 + 认领共享任务 + 派新简报」，把已完成任务的老成员直接流转到下一段。reassign 会顺手把它的 retired 清掉、用简报首行更新职责描述。内核 durable name 不可改（投影禁止），改名发生在编排层，旧名字仍然可寻址。",
    "team_member_add：新建成员（name/description/brief，可带 alias/priority/tags；满员时按 auto_capacity 自动提额，不会再撞 TEAM_MEMBER_LIMIT）。",
    "team_member_delete：硬删除（不可逆）：中断并释放运行激活、在编排层立墓碑、并让任何通道发给它的消息都被拒绝；同时自动补 1 个名额，使「删掉再新建」真的可行。注意内核 roster 是只能追加的日志、投影只允许 provisioning→active|failed，所以已 active 的记录无法被改写或移除——上游仍会把它显示为 inactive，真正的效果来自编排层墓碑 + 消息拦截 + 提额。",
    "team_capacity_set：直接改成员上限（随 profile 配置而来，本机为 8）。收到 TEAM_MEMBER_LIMIT 时用它。",
    "team_message：按名字/别名给 teammate 发消息；target 写成 child session id 就能直接 steer 一个非 roster 的 continuable subagent——这是给 subagent 中途下指令的通道（团队版 send_message 只认 roster 成员，会报 active teammate not found）。被删除的成员即使内核记录还在，任何通道发给它的消息都会被编排层拒绝。",
    "",
    "委派方式怎么选：一次性的、有界的、能自包含的收尾任务用 subagent（全新上下文、只回结果、不占团队名额）；需要反复中途 steer 的长期角色才用 durable teammate。默认策略是「同类收尾任务逐轮新建 subagent」，而不是反复唤醒同一个 teammate。",
    "",
    "改代码的纪律：用编辑工具就地改——先 read 刷新观察状态，再用唯一字符串替换（不要用行号，行号会漂移），一次一处、改完立刻跑自检。不要生成外部补丁脚本，也不要用 shell heredoc 打补丁：那类脚本会因为引号/语法问题静默失败，看起来「改过了」其实产物没变。编辑若报观察状态已过期或未读，正确恢复是先重新 read 该文件再编辑，别放弃本轮。"
  ].join("\n");
}

// ---------------------------------------------------------------------------
// installation
// ---------------------------------------------------------------------------

/** Validate and default the bundle config. */
function normalizeOptions(ctx, config) {
  const raw = config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) ctx.logger?.warn?.(`[${PLUGIN_ID}] unknown config key "${key}" was ignored`);
  }
  return {
    dedupeSettlementNotices: raw.dedupeSettlementNotices !== false,
    blockDeletedTargets: raw.blockDeletedTargets !== false,
    defaultContextWindow: finite(raw.defaultContextWindow),
    maxOverviewNotices: Math.max(1, Math.min(50, Math.round(finite(raw.maxOverviewNotices) ?? 10))),
    freshProvider: typeof raw.freshProvider === "string" && raw.freshProvider.length > 0 ? raw.freshProvider : "spawn",
    forkProvider: typeof raw.forkProvider === "string" && raw.forkProvider.length > 0 ? raw.forkProvider : "fork",
    verboseLogging: raw.verboseLogging === true
  };
}

/** Install the conductor tools and policy into one live agent scope. */
function install(agent, ctx, state) {
  const scoped = agent.ctx;
  const disposers = [];
  const register = (disposer) => {
    if (typeof disposer === "function") disposers.push(disposer);
  };
  const failures = [];
  const tools = buildTools(ctx, state.options, state);
  try {
    register(scoped.systemPrompt?.section?.({ name: SECTION_NAME, order: SECTION_ORDER, text: policyText() }));
  } catch (error) {
    failures.push(`policy section: ${messageOf(error)}`);
  }
  for (const tool of tools) {
    try {
      register(scoped.tools?.register?.(tool));
    } catch (error) {
      failures.push(`tool ${tool.name}: ${messageOf(error)}`);
    }
  }
  if (failures.length > 0) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] partial install for agent "${agent.id}": ${failures.join("; ")}`);
    state.stats.installFailures = (state.stats.installFailures ?? 0) + failures.length;
  }
  state.toolNames = tools.map((tool) => tool.name);
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* teardown is best effort */
      }
    }
  };
}

/** Plugin entry point. */
export function apply(ctx, config = {}) {
  const options = normalizeOptions(ctx, config);
  const state = {
    options,
    installed: new Map(),
    stats: { suppressedNotices: 0, blockedDeletedSends: 0, installFailures: 0 },
    guard: undefined,
    deleteGuard: undefined,
    toolNames: []
  };
  state.guardStatus = ensureGuard(ctx, state);
  state.deleteGuardStatus = ensureDeleteGuard(ctx, state);
  // The `subagents` service binds after this plugin in the shipped profile, so
  // a one-shot attempt at apply time reports `pending`. Re-drive the idempotent
  // install from the cordis service-binding hook (the same seam
  // dsh-agent-preset-registry uses) and lazily from every tool call.
  try {
    ctx.on("internal/service", (serviceName) => {
      if (serviceName !== "subagents" && serviceName !== "agentTeams") return;
      ensureGuard(ctx, state);
      ensureDeleteGuard(ctx, state);
      for (const agent of listAgents(ctx)) {
        ensureGuard(ctx, state, agent);
        ensureDeleteGuard(ctx, state, agent);
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] service-binding hook was not registered: ${messageOf(error)}`);
  }

  const maybeInstall = (agent) => {
    if (state.installed.has(agent)) return;
    if (membershipOf(ctx, agent) === undefined) return;
    try {
      state.installed.set(agent, install(agent, ctx, state));
    } catch (error) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] install for agent "${agent.id}" failed: ${messageOf(error)}`);
    }
  };

  for (const agent of listAgents(ctx)) maybeInstall(agent);
  ctx.on("agent/created", ({ agent }) => maybeInstall(agent));
  ctx.on("agent/disposed", ({ agent }) => {
    state.installed.get(agent)?.();
    state.installed.delete(agent);
  });
  ctx.effect(
    () => () => {
      for (const dispose of state.installed.values()) dispose();
      state.installed.clear();
      removeSettlementGuard(ctx, state);
      removeDeleteGuard(state);
    },
    `${PLUGIN_ID}.scopedTools()`
  );

  // Loopback status route — the cheap way to verify the plugin mounted.
  try {
    const webServer = ctx.get("webServer");
    if (webServer !== undefined && typeof webServer.register === "function") {
      const disposer = webServer.register({
        kind: "exact",
        path: STATUS_ROUTE,
        handler: (req, res) => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.statusCode = 405;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: false, reason: "method-not-allowed" }));
            return;
          }
          if (!requestAllowed(req)) {
            res.statusCode = 403;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: false, reason: "forbidden" }));
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            ok: true,
            plugin: PLUGIN_ID,
            version: PLUGIN_VERSION,
            teamService: teamService(ctx) !== undefined,
            tools: state.toolNames,
            installedAgents: state.installed.size,
            settlementGuard: state.guardStatus ?? "unknown",
            settlementGuardScope: state.guard?.scope ?? null,
            suppressedNotices: state.stats.suppressedNotices,
            deleteGuard: state.deleteGuardStatus ?? "unknown",
            deleteGuardScope: state.deleteGuard?.scope ?? null,
            blockedDeletedSends: state.stats.blockedDeletedSends,
            installFailures: state.stats.installFailures,
            store: storeDir()
          }));
        }
      });
      ctx.effect(() => disposer, `${PLUGIN_ID}.statusRoute()`);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] status route was not registered: ${messageOf(error)}`);
  }

  ctx.logger?.info?.(
    `[${PLUGIN_ID}] v${PLUGIN_VERSION} mounted: tools=${state.toolNames.join(",") || "(none)"} settlementGuard=${state.guardStatus ?? "unknown"} teamService=${teamService(ctx) !== undefined}`
  );
}

/** Same loopback-only gate used by the other shipped profile plugins. */
function requestAllowed(req) {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site.length > 0) return site !== "cross-site";
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    try {
      return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  return true;
}

/** Test seam: the pure helpers above are not exported by the plugin surface,
 * but the smoke suite imports them through this underscored object. */
export const __test = {
  PLUGIN_ID,
  PLUGIN_VERSION,
  SECTION_NAME,
  SECTION_ORDER,
  STATUS_ROUTE,
  TEXT_OUTPUT_SCHEMA,
  buildTools,
  defineConductorTool,
  validateSubset,
  assertArgumentShape,
  settlementLedger,
  resolveTarget,
  saturationLevel,
  effectiveBudget,
  ensureGuard,
  ensureDeleteGuard,
  isOurWrapper,
  wrapMethodOnce,
  resolveActivationRegistry,
  blockedTarget,
  sealNote,
  renameMember,
  raiseCeiling,
  sealMemberInKernel,
  looksLikeSessionId,
  normalizeOptions,
  policyText,
  digest,
  measureMember,
  dshHome,
  storeDir,
  storeFile,
  readStore,
  writeStore,
  updateMemberRecord
};