/**
 * Smoke suite for dsh-team-conductor.
 *
 * It cannot import the harness (profile plugins live outside app.asar), so the
 * suite fakes the cordis context and every host service the plugin reaches,
 * then asserts:
 *
 *   1. the module loads and exports the cordis plugin surface;
 *   2. every authored tool schema stays inside the JSON-Schema subset that
 *      `tools.register()` enforces (mirrored from @deepseek-ai/dsh-tools);
 *   3. each tool definition satisfies the registry contract (name/description/
 *      parameters/output{schema,render}/execute);
 *   4. the settlement guard suppresses a second notice for one Activation;
 *   5. every action of team_member_edit, both capacity paths, both delivery
 *      channels, the overview measurements and the notice ledger behave.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "dsh-team-conductor-"));
process.env.DSH_HOME = HOME;

const mod = await import("../lib/index.js");
const T = mod.__test;

const checks = [];
function check(name, body) {
  return Promise.resolve()
    .then(body)
    .then(() => {
      checks.push({ name, ok: true });
    })
    .catch((error) => {
      checks.push({ name, ok: false, error: String(error?.message ?? error) });
    });
}

// ---------------------------------------------------------------------------
// schema-subset mirror of @deepseek-ai/dsh-tools
// ---------------------------------------------------------------------------

const CONSTRAINT_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const"]);
const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);
const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Collect every violation of the enforced subset, mirroring the harness rules. */
function subsetViolations(schema, path = "schema", seen = new Set()) {
  const problems = [];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [`${path} must be a schema object`];
  if (seen.has(schema)) return [`${path} is circular`];
  seen.add(schema);
  for (const key of Object.keys(schema)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    problems.push(`${path}.${key} is not a supported keyword`);
  }
  const hasType = Object.hasOwn(schema, "type");
  const hasOneOf = Object.hasOwn(schema, "oneOf");
  if (hasType && hasOneOf) return [...problems, `${path} cannot declare both type and oneOf`];
  if (!hasType && !hasOneOf) return [...problems, `${path} must declare type or oneOf`];
  if (hasType) {
    if (typeof schema.type !== "string" || !SCHEMA_TYPES.has(schema.type)) problems.push(`${path}.type is not a supported type`);
    for (const [key, owner] of [
      ["properties", "object"],
      ["required", "object"],
      ["additionalProperties", "object"],
      ["items", "array"],
      ["enum", "scalar"],
      ["const", "scalar"]
    ]) {
      if (!Object.hasOwn(schema, key)) continue;
      if (owner === "scalar" && ["object", "array"].includes(schema.type)) problems.push(`${path}.${key} is not supported on type "${schema.type}"`);
      else if (owner !== "scalar" && owner !== schema.type) problems.push(`${path}.${key} is not supported on type "${schema.type}"`);
    }
    if (Object.hasOwn(schema, "additionalProperties") && typeof schema.additionalProperties !== "boolean") problems.push(`${path}.additionalProperties must be a boolean`);
    if (Object.hasOwn(schema, "properties")) {
      for (const [key, child] of Object.entries(schema.properties)) problems.push(...subsetViolations(child, `${path}.properties.${key}`, seen));
    }
    if (Object.hasOwn(schema, "items")) problems.push(...subsetViolations(schema.items, `${path}.items`, seen));
    if (Object.hasOwn(schema, "required")) {
      if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== "string")) problems.push(`${path}.required must be an array of strings`);
    }
    if (Object.hasOwn(schema, "enum") && (!Array.isArray(schema.enum) || schema.enum.length === 0)) problems.push(`${path}.enum must be a non-empty array`);
  }
  if (hasOneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) problems.push(`${path}.oneOf must be an array of at least two schemas`);
    else for (const sibling of ["properties", "required", "additionalProperties", "items", "enum", "const"]) {
      if (Object.hasOwn(schema, sibling)) problems.push(`${path}.${sibling} is not supported beside oneOf`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// fake host
// ---------------------------------------------------------------------------

function makeSession(id, parent, events = []) {
  return {
    id,
    header: { version: 4, id, createdAt: Date.now(), cwd: process.cwd(), parentSession: parent },
    events,
    seq: events.length,
    eventAt: (index) => events[index],
    requestHeader: () => ({ config: { provider: "workbuddy-global", model: "deepseek-v4.1-flash" } })
  };
}

function userMessage(source, text) {
  return { type: "user/message", seq: undefined, data: { content: [{ type: "text", text }], source } };
}

const settlementSource = (child, summary) => ({ kind: "subagent-settled", form: "notice", summary, senderSessionId: child });

function makeAgent(id, { parent, status = "idle" } = {}) {
  const registered = new Map();
  const sections = [];
  return {
    id,
    status,
    options: { provider: "workbuddy-global", model: "deepseek-v4.1-flash" },
    session: makeSession(id, parent),
    ctx: {
      tools: {
        register: (definition) => {
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        }
      },
      systemPrompt: {
        section: (section) => {
          sections.push(section);
          return () => {};
        }
      }
    },
    __registered: registered,
    __sections: sections
  };
}

const leadEvents = [
  userMessage(settlementSource("child-a", "Background subagent child-a finished"), "closing A"),
  userMessage(settlementSource("child-a", "Background subagent child-a finished"), "closing A"),
  userMessage(settlementSource("child-b", "Background subagent child-b finished"), "closing B")
];
leadEvents.forEach((event, index) => {
  event.seq = index;
});

const lead = makeAgent("lead-1");
lead.session = makeSession("lead-1", undefined, leadEvents);
const reviewer = makeAgent("rev-1", { parent: "lead-1" });
const spawnedChild = makeAgent("child-z", { parent: "lead-1" });

const rows = [
  { id: "lead-1", name: "lead", role: "lead", status: "inactive", diagnostics: [] },
  {
    id: "rev-1",
    name: "reviewer",
    role: "teammate",
    status: "inactive",
    description: "reviews diffs",
    provider: "spawn",
    context: "fresh",
    model: "deepseek-v4.1-flash",
    diagnostics: []
  }
];

const calls = { sent: [], stopped: [], interrupted: [], notified: [], compacted: 0, childMessages: [], spawned: [], sealed: [], taskUpdates: [] };
const routes = new Map();
const listeners = [];
const effects = [];

/** Upstream roster records, as the journal replay would hold them. */
const journalMembers = [{ id: "rev-1", name: "reviewer", description: "reviews diffs", provider: "spawn", context: "fresh", phase: "active" }];
const journal = {
  async transact(_rootId, operation) {
    return await operation();
  },
  async appendAndFlush(_root, type, data) {
    calls.sealed.push({ type, data });
    const index = journalMembers.findIndex((member) => member.id === data.member.id);
    if (index >= 0) journalMembers[index] = data.member;
    else journalMembers.push(data.member);
  },
  state() {
    return { members: journalMembers };
  }
};

const teamService = {
  roster: {
    maxMembers: 8,
    stopTeammates: async (_root, ids) => {
      calls.stopped.push(ids);
    }
  },
  config: { maxMembers: 8 },
  journal,
  tryMembership(agent) {
    if (agent === lead) return { root: lead, id: "lead-1", role: "lead", name: "lead" };
    if (agent === reviewer) return { root: lead, id: "rev-1", role: "teammate", name: "reviewer" };
    if (agent?.id === "late-1") return { root: lead, id: "late-1", role: "teammate", name: "late" };
    return undefined;
  },
  listMembers() {
    return rows;
  },
  async sendMessage(_caller, request) {
    calls.sent.push(request);
    return { messageId: "team-msg-1", status: "accepted" };
  },
  interrupt(_caller, target) {
    calls.interrupted.push(target);
    return { previousStatus: "inactive" };
  },
  getTask(_caller, id) {
    return { id, revision: 3, subject: "next shared task", status: "pending", description: "", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] };
  },
  async updateTask(_caller, request) {
    calls.taskUpdates.push(request);
    return { id: request.taskId, revision: request.expectedRevision + 1, ownerName: request.owner, status: "pending", subject: "next shared task", description: "", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] };
  },
  async spawnTeammate(_caller, request) {
    calls.spawned.push(request);
    const teammates = rows.filter((row) => row.role === "teammate").length;
    if (teammates >= teamService.roster.maxMembers) throw new Error(`Team member limit ${teamService.roster.maxMembers} reached`);
    const id = `new-${calls.spawned.length}`;
    const row = { id, name: request.name, role: "teammate", status: "inactive", description: request.description, provider: request.provider, context: request.context, diagnostics: [] };
    rows.push(row);
    journalMembers.push({ id, name: request.name, description: request.description, provider: request.provider, context: request.context, phase: "active" });
    return { member: row };
  }
};

/**
 * A stand-in for the real `subagents` service shape, bound *after* apply() on
 * purpose: `notifySettlement` lives on the activation registry
 * (`subagents.continuations.activations`), never on the service itself — the
 * mistake that made an earlier revision silently no-op on a real kernel.
 *
 * It is wrapped in a Proxy to mimic cordis: `Object.defineProperty` lands on
 * the target, while reading a function-valued property back through the Proxy
 * must not be trusted for reference equality.
 */
const activationsRegistry = {
  settled: [],
  notifySettlement(activation) {
    this.settled.push(activation);
    calls.notified.push(activation);
  }
};
const subagentsService = new Proxy({
  continuations: { activations: activationsRegistry },
  async sendMessage(_caller, childId, _content) {
    calls.childMessages.push(childId);
    return "child-msg-1";
  }
}, {});

const services = {
  agents: {
    list: () => [lead, reviewer, spawnedChild],
    get: (id) => [lead, reviewer, spawnedChild].find((agent) => agent.id === id)
  },
  agentTeams: teamService,
  tokenMeter: { measure: () => ({ totalTokens: 150000 }) },
  llm: { resolveModelInfo: async () => ({ context: { contextWindow: 200000 } }) },
  sessions: { get: () => undefined, prepare: () => { throw new Error("detached replay not exercised"); } },
  sessionPersistence: { open: async () => { throw new Error("persistence not exercised"); } },
  compaction: {
    compactNow: async () => {
      calls.compacted += 1;
      return { ok: true };
    }
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    }
  }
};

const ctx = {
  get: (serviceName) => services[serviceName],
  on: (event, callback) => {
    listeners.push({ event, callback });
    return () => {};
  },
  effect: (factory) => {
    const disposer = factory();
    effects.push(disposer);
    return () => {};
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} }
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

mod.apply(ctx, {});

const tool = (agent, toolName) => {
  const definition = agent.__registered.get(toolName);
  assert.ok(definition, `${toolName} was not registered on ${agent.id}`);
  return definition;
};

const runTool = async (agent, toolName, args) => {
  const value = await tool(agent, toolName).execute(args, { agent });
  return JSON.parse(value.text);
};

/** Read the plugin's own status route the way the GUI/host would. */
const callStatus = () => new Promise((resolveBody) => {
  const route = routes.get(T.STATUS_ROUTE);
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      resolveBody({ statusCode: this.statusCode, headers: this.headers, payload: JSON.parse(payload) });
    }
  };
  route.handler({ method: "GET", headers: {} }, res);
});

// 1. plugin surface
await check("exports the cordis plugin surface", () => {
  assert.equal(mod.name, "team-conductor");
  // Only `agents` is required: everything is registered through the per-agent
  // scope, and requiring `tools`/`systemPrompt` silently parked the whole plugin
  // in a composition that publishes them elsewhere (a headless profile composed
  // the entity but never ran apply).
  assert.deepEqual(mod.inject, ["agents"]);
  assert.equal(typeof mod.apply, "function");
});

// 2. schema subset, 3. registry contract
await check("every authored schema stays inside the enforced subset", () => {
  const tools = T.buildTools(ctx, { dedupeSettlementNotices: true, maxOverviewNotices: 10 }, { stats: { suppressedNotices: 0 } });
  assert.equal(tools.length, 9);
  for (const definition of tools) {
    const problems = [...subsetViolations(definition.parameters, `${definition.name}.parameters`), ...subsetViolations(T.TEXT_OUTPUT_SCHEMA, `${definition.name}.output`)];
    assert.deepEqual(problems, [], `${definition.name}: ${problems.join("; ")}`);
  }
});

await check("every tool satisfies the registry contract", () => {
  for (const agent of [lead, reviewer]) {
    assert.deepEqual([...agent.__registered.keys()].sort(), ["team_capacity_set", "team_member_add", "team_member_delete", "team_member_edit", "team_message", "team_overview", "team_task_add", "team_task_list", "team_task_update"]);
    for (const definition of agent.__registered.values()) {
      assert.equal(typeof definition.description, "string");
      assert.ok(definition.description.length > 40, `${definition.name} needs a real description`);
      assert.equal(typeof definition.output.render, "function");
      assert.equal(definition.output.schema, T.TEXT_OUTPUT_SCHEMA);
      assert.equal(typeof definition.execute, "function");
      const rendered = definition.output.render({}, { text: "x" });
      assert.deepEqual(rendered, [{ type: "text", text: "x" }]);
    }
  }
  assert.equal(lead.__sections.length, 1);
  assert.equal(lead.__sections[0].name, T.SECTION_NAME);
  assert.equal(lead.__sections[0].order, T.SECTION_ORDER);
});

// 4. settlement guard — the service binds AFTER apply() in the shipped profile
await check("the settlement guard is re-driven when the service binds late", async () => {
  const before = await callStatus();
  assert.equal(before.payload.settlementGuard, "pending", "an apply-time miss must stay pending, not fail forever");
  services.subagents = subagentsService;
  for (const listener of listeners.filter((entry) => entry.event === "internal/service")) listener.callback("subagents", services.subagents);
  const after = await callStatus();
  assert.equal(after.payload.settlementGuard, "active", "the internal/service hook must install the guard");
  assert.equal(after.payload.settlementGuardScope, "subagents.continuations.activations");
  const activation = { childId: "child-a" };
  activationsRegistry.notifySettlement(activation, { stopReason: "completed" });
  activationsRegistry.notifySettlement(activation, { stopReason: "completed" });
  activationsRegistry.notifySettlement({ childId: "child-b" }, { stopReason: "completed" });
  assert.equal(calls.notified.length, 2, "the duplicate for one activation must be dropped");
  assert.equal(calls.notified[0].childId, "child-a");
  assert.equal(calls.notified[1].childId, "child-b");
});

await check("the guard wraps the activation registry, not the service object", async () => {
  // The trap: a service-level method of the same name must stay untouched.
  assert.equal(subagentsService.notifySettlement, undefined, "the service must not grow a notifySettlement of its own");
  assert.equal(T.isOurWrapper(activationsRegistry.notifySettlement), true, "the registry method must be ours");
  // Idempotent: re-driving must not stack another layer.
  const state = { options: { dedupeSettlementNotices: true }, stats: { suppressedNotices: 0 } };
  assert.equal(T.ensureGuard(ctx, state), "active");
  assert.equal(T.isOurWrapper(activationsRegistry.notifySettlement), true);
  assert.equal(String(activationsRegistry.notifySettlement.name), "notifySettlementOnce");
});

await check("a Proxy readback cannot produce a false failure", () => {
  // Mimic cordis: the Proxy re-wraps function values on get, so `!==` would lie.
  const target = { ping() { return "pong"; } };
  const proxy = new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);
      return typeof value === "function" ? new Proxy(value, {}) : value;
    }
  });
  const wrapped = T.wrapMethodOnce(target, "ping", (original) => function pingOnce() { return `${original()}+guarded`; });
  assert.ok(wrapped, "wrapMethodOnce must report success from the descriptor, not a Proxy readback");
  assert.equal(target.ping(), "pong+guarded");
  assert.equal(proxy.ping() !== target.ping, true, "the Proxy readback really does differ, which is why it must not be the success test");
  const again = T.wrapMethodOnce(target, "ping", () => { throw new Error("must not re-wrap"); });
  assert.equal(again.alreadyInstalled, true, "a second attempt must be a no-op, not another layer");
});

await check("the guard tolerates a non-object activation and a missing method", () => {
  activationsRegistry.notifySettlement(null, { stopReason: "completed" });
  activationsRegistry.notifySettlement(undefined, { stopReason: "completed" });
  assert.equal(calls.notified.length, 4, "null/undefined activations must pass through untouched");
});

// 5. overview
await check("team_overview reports roster, pressure, capacity and the notice ledger", async () => {
  const payload = await runTool(lead, "team_overview", {});
  assert.equal(payload.team.capacity.used, 1);
  assert.equal(payload.team.capacity.max, 8);
  assert.equal(payload.team.capacity.free, 7);
  assert.equal(payload.team.capacity.full, false);
  assert.equal(payload.members.length, 2);
  const member = payload.members.find((entry) => entry.role === "teammate");
  assert.equal(member.target, "reviewer");
  assert.equal(member.contextPressure.known, true);
  assert.equal(member.contextPressure.tokens, 150000);
  assert.equal(member.contextPressure.contextWindow, 200000);
  assert.equal(member.contextPressure.level, "near_saturated");
  assert.equal(member.contextPressure.ratio, 0.75);
  assert.equal(payload.settlements.total, 3);
  assert.equal(payload.settlements.unique, 2);
  assert.equal(payload.settlements.repeats.length, 1);
  assert.equal(payload.settlements.repeats[0].count, 2);
  assert.deepEqual(payload.settlements.repeats[0].seqs, [0, 1]);
  assert.ok(payload.diagnostics.some((note) => note.includes("near_saturated")));
  assert.equal(payload.children.length, 1);
  assert.equal(payload.children[0].id, "child-z");
});

await check("team_overview can omit the settlement ledger", async () => {
  const payload = await runTool(lead, "team_overview", { include_settlements: false, include_children: false });
  assert.equal(payload.settlements, undefined);
  assert.equal(payload.children, undefined);
});

// 6. member editing
await check("team_member_edit sets alias, description, priority, tags and budget", async () => {
  const alias = await runTool(lead, "team_member_edit", { target: "reviewer", action: "alias", value: "rev" });
  assert.equal(alias.record.alias, "rev");
  const described = await runTool(lead, "team_member_edit", { target: "reviewer", action: "describe", value: "owns the diff review" });
  assert.equal(described.record.description, "owns the diff review");
  const prioritized = await runTool(lead, "team_member_edit", { target: "reviewer", action: "priority", priority: 5 });
  assert.equal(prioritized.record.priority, 5);
  const tagged = await runTool(lead, "team_member_edit", { target: "reviewer", action: "tags", tags: ["review", "diff"] });
  assert.deepEqual(tagged.record.tags, ["review", "diff"]);
  const budgeted = await runTool(lead, "team_member_edit", { target: "reviewer", action: "budget", token_budget: 100000 });
  assert.equal(budgeted.record.tokenBudget, 100000);
  const cleared = await runTool(lead, "team_member_edit", { target: "reviewer", action: "budget", token_budget: 0 });
  assert.equal(cleared.record.tokenBudget, undefined);

  const stored = T.readStore("lead-1");
  assert.equal(stored.members.reviewer.alias, "rev");
});

await check("a member budget overrides the model window for saturation", async () => {
  await runTool(lead, "team_member_edit", { target: "reviewer", action: "budget", token_budget: 160000 });
  const payload = await runTool(lead, "team_overview", {});
  const member = payload.members.find((entry) => entry.role === "teammate");
  assert.equal(member.contextPressure.tokenBudget, 160000);
  assert.equal(member.contextPressure.level, "over");
  assert.equal(member.contextPressure.remaining, 10000);
  await runTool(lead, "team_member_edit", { target: "reviewer", action: "budget", token_budget: 0 });
});

await check("a budget above the window cannot mask window pressure", async () => {
  await runTool(lead, "team_member_edit", { target: "reviewer", action: "budget", token_budget: 400000 });
  const payload = await runTool(lead, "team_overview", {});
  const member = payload.members.find((entry) => entry.role === "teammate");
  assert.equal(member.contextPressure.level, "near_saturated", "the effective budget must stay min(window, budget)");
  await runTool(lead, "team_member_edit", { target: "reviewer", action: "budget", token_budget: 0 });
});

await check("team_member_edit re-briefs over the team channel", async () => {
  const before = calls.sent.length;
  const payload = await runTool(lead, "team_member_edit", { target: "reviewer", action: "rebrief", message: "fresh brief" });
  assert.equal(calls.sent.length, before + 1);
  assert.equal(calls.sent.at(-1).target, "reviewer");
  assert.equal(calls.sent.at(-1).content[0].text, "fresh brief");
  assert.ok(payload.effects.some((effect) => effect.includes("team channel")));
});

await check("team_member_edit compacts a live member", async () => {
  const payload = await runTool(lead, "team_member_edit", { target: "reviewer", action: "compact" });
  assert.equal(calls.compacted, 1);
  assert.deepEqual(payload.warnings, []);
  assert.ok(payload.effects.some((effect) => effect.includes("compaction applied")));
});

await check("team_member_edit interrupts and retires", async () => {
  reviewer.status = "running";
  const retired = await runTool(lead, "team_member_edit", { target: "reviewer", action: "retire" });
  reviewer.status = "idle";
  assert.deepEqual(calls.interrupted, ["reviewer"]);
  assert.deepEqual(calls.stopped, [["rev-1"]]);
  assert.equal(retired.record.retired, true);
  const restored = await runTool(lead, "team_member_edit", { target: "rev", action: "restore" });
  assert.equal(restored.record.retired, false);
});

await check("team_member_edit rejects bad arguments", async () => {
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "alias" }), /value is required|value must be/);
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "nope" }), /must be one of/);
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "ghost", action: "alias", value: "g" }), /not a teammate name/);
});

// 7. capacity
await check("team_capacity_set raises the member ceiling", async () => {
  const payload = await runTool(lead, "team_capacity_set", { max_members: 24, reason: "six-issue plugin work" });
  assert.equal(payload.before, 8);
  assert.equal(payload.after, 24);
  assert.equal(payload.used, 1);
  assert.equal(payload.free, 23);
  assert.equal(teamService.roster.maxMembers, 24);
  assert.equal(T.readStore("lead-1").capacity.observedMax, 24);
  await runTool(lead, "team_capacity_set", { max_members: 8 });
});

await check("team_capacity_set refuses to strand existing members", async () => {
  await assert.rejects(() => runTool(lead, "team_capacity_set", { max_members: 0 }), />= 1/);
});

await check("team_capacity_set is Lead-only", async () => {
  await assert.rejects(() => tool(reviewer, "team_capacity_set").execute({ max_members: 12 }, { agent: reviewer }), /Lead-only/);
});

// 8. delivery channels
await check("team_message reaches a teammate by alias", async () => {
  const before = calls.sent.length;
  const payload = await runTool(lead, "team_message", { target: "rev", message: "ping" });
  assert.equal(calls.sent.length, before + 1);
  assert.equal(payload.target.kind, "teammate");
  assert.equal(payload.target.coreName, "reviewer");
  assert.equal(payload.delivery.channel, "team");
  assert.equal(payload.delivery.messageId, "team-msg-1");
});

await check("team_message steers a non-roster subagent by child session id", async () => {
  const childId = "abcdef01-2345-6789-abcd-ef0123456789";
  const payload = await runTool(lead, "team_message", { target: childId, message: "keep going" });
  assert.deepEqual(calls.childMessages, [childId]);
  assert.equal(payload.target.kind, "child");
  assert.equal(payload.delivery.channel, "subagent");
});

await check("team_message refuses a self-send and unknown names", async () => {
  await assert.rejects(() => runTool(lead, "team_message", { target: "lead", message: "hi me" }), /cannot send a message to itself/);
  await assert.rejects(() => runTool(lead, "team_message", { target: "nobody", message: "hi" }), /not a teammate name/);
});

// 9. add / delete
await check("team_member_add creates a member and records orchestration metadata", async () => {
  const payload = await runTool(lead, "team_member_add", { name: "scribe", description: "writes the docs", brief: "write the README", alias: "scribe-alias", priority: 3, tags: ["docs"] });
  assert.equal(payload.member.target, "scribe");
  assert.equal(calls.spawned.at(-1).name, "scribe");
  assert.equal(calls.spawned.at(-1).provider, "spawn");
  assert.equal(calls.spawned.at(-1).context, "fresh");
  assert.equal(payload.record.alias, "scribe-alias");
  assert.equal(payload.record.priority, 3);
  assert.deepEqual(payload.record.tags, ["docs"]);
  const addressed = await runTool(lead, "team_message", { target: "scribe-alias", message: "go" });
  assert.equal(addressed.target.coreName, "scribe");
});

await check("team_member_add raises the ceiling instead of failing when the Team is full", async () => {
  teamService.roster.maxMembers = 2;
  const payload = await runTool(lead, "team_member_add", { name: "temp", description: "bounded work", brief: "do exactly one thing" });
  assert.ok(payload.effects.some((effect) => effect.includes("member ceiling raised 2 → 3")), JSON.stringify(payload.effects));
  assert.equal(teamService.roster.maxMembers, 3);
  assert.equal(payload.member.target, "temp");
});

await check("team_member_add can refuse to auto-raise", async () => {
  await assert.rejects(
    () => runTool(lead, "team_member_add", { name: "nope", description: "x", brief: "y", auto_capacity: false }),
    /the Team is full/
  );
});

await check("team_member_add is Lead-only and validates its arguments", async () => {
  await assert.rejects(() => tool(reviewer, "team_member_add").execute({ name: "x", description: "y", brief: "z" }, { agent: reviewer }), /Lead-only/);
  await assert.rejects(() => runTool(lead, "team_member_add", { name: "x", description: "y" }), /brief must be a non-empty string/);
});

await check("team_member_delete tombstones, refuses illegal upstream rewrites and frees a slot", async () => {
  const before = teamService.roster.maxMembers;
  const sealedBefore = calls.sealed.length;
  const payload = await runTool(lead, "team_member_delete", { target: "temp", reason: "bounded work finished" });
  assert.equal(payload.deleted.seal, "immutable-active", "an active roster record can never be rewritten");
  assert.equal(payload.deleted.upstreamRecordRemoved, false);
  assert.equal(calls.sealed.length, sealedBefore, "no illegal team/member append may even be attempted");
  assert.equal(teamService.roster.maxMembers, before + 1);
  const stored = T.readStore("lead-1").members.temp;
  assert.equal(stored.deleted, true);
  assert.equal(stored.deleteReason, "bounded work finished");
  assert.ok(payload.effects.some((effect) => effect.includes("forbids rewriting")), JSON.stringify(payload.effects));
  assert.ok(payload.note.includes("conductor-level"), payload.note);
});

await check("a deleted member is unaddressable and irreversible", async () => {
  await assert.rejects(() => runTool(lead, "team_message", { target: "temp", message: "again" }), /was deleted/);
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "temp", action: "restore" }), /was deleted/);
  await assert.rejects(() => runTool(lead, "team_member_delete", { target: "temp" }), /was deleted/);
});

await check("team_member_delete is Lead-only and needs a roster member", async () => {
  await assert.rejects(() => tool(reviewer, "team_member_delete").execute({ target: "reviewer" }, { agent: reviewer }), /Lead-only/);
  const childId = "abcdef01-2345-6789-abcd-ef0123456789";
  await assert.rejects(() => runTool(lead, "team_member_delete", { target: childId }), /applies to a roster teammate/);
});

await check("deleting a provisioning member seals it on the one legal terminal edge", async () => {
  const scribe = journalMembers.find((member) => member.name === "scribe");
  assert.ok(scribe, "scribe must be a roster record by now");
  scribe.phase = "provisioning";
  const sealedBefore = calls.sealed.length;
  const payload = await runTool(lead, "team_member_delete", { target: "scribe", seal_kernel: true, auto_capacity: false });
  assert.equal(payload.deleted.seal, "sealed-provisioning");
  assert.equal(calls.sealed.length, sealedBefore + 1, "provisioning -> failed is the one legal terminal edge");
  assert.equal(calls.sealed.at(-1).data.member.phase, "failed");
  assert.equal(calls.sealed.at(-1).data.member.error, "deleted by dsh-team-conductor");
  assert.equal(payload.capacity, null, "auto_capacity: false must not touch the ceiling");
});

await check("the delete guard refuses messages to a deleted member from any caller", async () => {
  const blockedBefore = (await callStatus()).payload.blockedDeletedSends;
  await assert.rejects(
    () => teamService.sendMessage(lead, { target: "temp", content: [{ type: "text", text: "hi" }] }),
    /was deleted/
  );
  const after = await callStatus();
  assert.equal(after.payload.blockedDeletedSends, blockedBefore + 1);
  assert.equal(after.payload.deleteGuard, "active");
});

await check("team_member_edit renames in the orchestration layer and keeps old names addressable", async () => {
  const renamed = await runTool(lead, "team_member_edit", { target: "reviewer", action: "rename", value: "diff-reviewer" });
  assert.equal(renamed.record.alias, "diff-reviewer");
  assert.ok(renamed.record.formerNames.includes("rev"), JSON.stringify(renamed.record.formerNames));
  const byNew = await runTool(lead, "team_message", { target: "diff-reviewer", message: "hi" });
  assert.equal(byNew.target.coreName, "reviewer");
  const byOld = await runTool(lead, "team_message", { target: "rev", message: "hi again" });
  assert.equal(byOld.target.coreName, "reviewer");
  const byDurable = await runTool(lead, "team_message", { target: "reviewer", message: "still here" });
  assert.equal(byDurable.target.coreName, "reviewer");
});

await check("rename refuses durable-name and alias collisions", async () => {
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "rename", value: "reviewer" }), /already this member's durable name/);
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "rename", value: "temp" }), /durable name|already|used before/);
});

await check("team_member_edit reassign renames, hands over the next shared task and re-briefs", async () => {
  const updatesBefore = calls.taskUpdates.length;
  const payload = await runTool(lead, "team_member_edit", {
    target: "reviewer",
    action: "reassign",
    value: "task-runner",
    message: "Next task: verify the docs.\nRead README.md and report gaps.",
    task_id: "task-1",
    compact_first: true
  });
  assert.equal(payload.record.alias, "task-runner");
  assert.equal(payload.record.description, "Next task: verify the docs.");
  assert.equal(calls.taskUpdates.length, updatesBefore + 1);
  assert.equal(calls.taskUpdates.at(-1).action, "reassign");
  assert.equal(calls.taskUpdates.at(-1).owner, "reviewer");
  assert.deepEqual(payload.task, { id: "task-1", revision: 4, ownerName: "reviewer" });
  assert.ok(payload.effects.some((effect) => effect.includes("handed to")));
  assert.ok(payload.effects.some((effect) => effect.includes("compact_first")));
  assert.ok(calls.sent.at(-1).content[0].text.includes("Next task: verify the docs."));
});

await check("reassign requires a brief and is Lead-only", async () => {
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "reassign" }), /requires message/);
  await assert.rejects(() => tool(reviewer, "team_member_edit").execute({ target: "reviewer", action: "reassign", message: "x" }, { agent: reviewer }), /Lead-only/);
});

await check("team_overview flags idle members as reusable", async () => {
  const payload = await runTool(lead, "team_overview", {});
  const member = payload.members.find((entry) => entry.role === "teammate" && entry.deleted !== true);
  assert.ok(member, "a live teammate must be listed");
  assert.equal(member.availability, "idle-ready");
  assert.equal(member.displayName, member.alias ?? member.target);
  assert.ok(payload.diagnostics.some((note) => note.includes("idle and reusable")), JSON.stringify(payload.diagnostics));
});

// 10. pure helpers
await check("resolveTarget and looksLikeSessionId", () => {
  const membership = { root: lead, id: "lead-1", role: "lead", name: "lead" };
  assert.equal(T.looksLikeSessionId("abcdef01-2345-6789-abcd-ef0123456789"), true);
  assert.equal(T.looksLikeSessionId("session-12"), true);
  assert.equal(T.looksLikeSessionId("reviewer"), false);
  assert.equal(T.resolveTarget(ctx, lead, membership, rows, "reviewer").kind, "teammate");
  assert.equal(T.resolveTarget(ctx, lead, membership, rows, "rev").coreName, "reviewer");
  assert.equal(T.resolveTarget(ctx, lead, membership, rows, "lead").kind, "lead");
  assert.throws(() => T.resolveTarget(ctx, lead, membership, rows, "ghost"), /not a teammate name/);
});

await check("saturationLevel ladder", () => {
  assert.equal(T.saturationLevel(0), "unknown");
  assert.equal(T.saturationLevel(125000, 200000), "watch");
  assert.equal(T.saturationLevel(150000, 200000), "near_saturated");
  assert.equal(T.saturationLevel(190000, 200000), "over");
  assert.equal(T.saturationLevel(40000, 200000), "ok");
  assert.equal(T.saturationLevel(190000, 200000, 100000), "over");
  assert.equal(T.saturationLevel(150000, 200000, 400000), "near_saturated", "a budget above the window must not mask window pressure");
  assert.equal(T.saturationLevel(160000, undefined), "near_saturated");
});

await check("settlementLedger groups identical notices", () => {
  const ledger = T.settlementLedger(lead.session, 10);
  assert.equal(ledger.total, 3);
  assert.equal(ledger.unique, 2);
  assert.equal(ledger.recent.length, 3);
  assert.deepEqual(T.settlementLedger(undefined, 10), { total: 0, unique: 0, repeats: [], recent: [] });
});

await check("validateSubset enforces the authored contract", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string", enum: ["x", "y"] }, b: { type: "array", items: { type: "integer" } } },
    required: ["a"],
    additionalProperties: false
  };
  assert.deepEqual(T.validateSubset(schema, { a: "x", b: [1, 2] }, ""), []);
  assert.deepEqual(T.validateSubset(schema, { a: "x", b: [1, "2"] }, ""), ["b[1] must be integer"]);
  assert.ok(T.validateSubset(schema, {}, "").includes("a is required"));
  assert.ok(T.validateSubset(schema, { a: "z" }, "").some((problem) => problem.includes("must be one of")));
  assert.ok(T.validateSubset(schema, { a: "x", c: 1 }, "").includes("c is not allowed"));
  assert.deepEqual(T.validateSubset({ type: "object", properties: { nest: { type: "object", properties: { deep: { type: "string" } }, additionalProperties: false } } }, { nest: { deep: 1, extra: true } }, ""), ["nest.deep must be string", "nest.extra is not allowed"]);
});

await check("the policy carries the six-issue mandates", () => {
  const policy = T.policyText();
  for (const mandate of ["team_overview", "team_member_edit", "team_capacity_set", "team_message", "near_saturated", "subagent", "唯一字符串", "heredoc", "child session id", "retire"]) {
    assert.ok(policy.includes(mandate), `policy must mention ${mandate}`);
  }
});

await check("store round-trip is atomic and tolerant", () => {
  const store = T.readStore("missing-root");
  assert.deepEqual(store.members, {});
  const seeded = T.readStore("lead-1");
  T.writeStore("lead-1", { ...seeded, members: { ...seeded.members, keeper: { alias: "k" } } });
  assert.equal(T.readStore("lead-1").members.keeper.alias, "k");
  const updated = T.updateMemberRecord("lead-1", "keeper", (current) => ({ ...current, priority: 9 }));
  assert.equal(updated.priority, 9);
  assert.equal(T.readStore("lead-1").members.keeper.priority, 9);
  assert.ok(T.storeDir().endsWith(join("dsh-team-conductor", "teams")));
});

await check("member editing is scoped per team root", () => {
  T.updateMemberRecord("other-root", "reviewer", (current) => ({ ...current, alias: "other" }));
  assert.notEqual(T.readStore("lead-1").members.reviewer.alias, "other", "the two Team roots must not share member records");
  assert.equal(T.readStore("other-root").members.reviewer.alias, "other");
  rmSync(T.storeFile("other-root"));
});

await check("the detached replica carries a complete session header", async () => {
  // Live observation: a partial meta makes Session.fromRestore reject with
  // "session header version must be 4, got undefined", so the measurement would
  // silently degrade to unknown for every cold member.
  const prepared = [];
  const savedSessions = services.sessions;
  const savedPersistence = services.sessionPersistence;
  services.sessions = {
    get: () => undefined,
    prepare: (id, options) => {
      prepared.push({ id, options });
      const header = options?.meta;
      assert.equal(header?.version, 4, "restore path validates version");
      assert.equal(header?.id, id, "restore path validates id");
      assert.equal(typeof header?.createdAt, "number", "restore path validates createdAt");
      assert.equal(typeof header?.isSeeded, "boolean", "restore path validates isSeeded");
      return { seq: 0, eventAt: () => undefined, requestHeader: () => undefined };
    }
  };
  services.sessionPersistence = {
    open: async () => ({
      header: { version: 4, id: "cold-1", createdAt: 1700000000000, isSeeded: false, cwd: process.cwd(), parentSession: "lead-1" },
      inheritedEventCount: 0,
      async read() {
        return { events: [{ type: "turn/start", seq: 0, data: { turn: 1 } }] };
      },
      async close() {}
    })
  };
  try {
    const measured = await T.measureMember(ctx, { id: "cold-1" }, {}, undefined);
    assert.equal(prepared.length, 1, "the detached replica must be prepared once");
    assert.equal(prepared[0].id, "cold-1");
    assert.equal(measured.source, "persisted");
  } finally {
    services.sessions = savedSessions;
    services.sessionPersistence = savedPersistence;
  }
});

// 11. review follow-ups (P1–P6 + the delete-guard hole + the sidecar cache)
await check("P1: team_capacity_set keeps config.maxMembers in step with the roster", async () => {
  const before = teamService.config.maxMembers;
  const payload = await runTool(lead, "team_capacity_set", { max_members: 12 });
  assert.equal(payload.after, 12);
  assert.equal(payload.configured, 12, "the returned `configured` must match the enforced ceiling");
  assert.equal(teamService.config.maxMembers, 12, "service.config.maxMembers must not keep reporting the startup value");
  const overview = await runTool(lead, "team_overview", { include_pressure: false });
  assert.equal(overview.team.capacity.max, 12);
  assert.equal(overview.team.capacity.configured, 12, "overview must not report a divergent configured ceiling");
  await runTool(lead, "team_capacity_set", { max_members: before });
});

await check("P3: `lead` cannot be used as an alias or a renamed name", async () => {
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "alias", value: "lead" }), /Lead pseudo-row/);
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "alias", value: "LEAD" }), /Lead pseudo-row/);
  await assert.rejects(() => runTool(lead, "team_member_edit", { target: "reviewer", action: "rename", value: "lead" }), /Lead pseudo-row/);
  const after = await runTool(lead, "team_overview", { include_pressure: false });
  const member = after.members.find((entry) => entry.role === "teammate" && entry.deleted !== true);
  assert.notEqual(member.alias, "lead");
});

await check("P4: the settlement guard reinstalls when its owner is replaced", () => {
  const first = { notifySettlement(activation) { this.inbox = activation; } };
  const service = { continuations: { activations: first } };
  const localCtx = { get: (name) => (name === "subagents" ? service : undefined), logger: { warn: () => {} } };
  const state = { options: { dedupeSettlementNotices: true }, stats: { suppressedNotices: 0 } };
  assert.equal(T.ensureGuard(localCtx, state), "active");
  assert.equal(state.guard.owner, first);
  // a fiber reload hands out a brand-new registry instance
  const second = { notifySettlement(activation) { this.inbox = activation; } };
  service.continuations.activations = second;
  assert.equal(T.ensureGuard(localCtx, state), "active");
  assert.equal(state.guard.owner, second, "the guard must move to the new owner, not keep reporting active on a dead one");
  assert.equal(T.isOurWrapper(second.notifySettlement), true);
});

await check("P4: a service that has not published its registry yet is pending, not unsupported", () => {
  const service = { continuations: undefined };
  const localCtx = { get: (name) => (name === "subagents" ? service : undefined), logger: { warn: () => {} } };
  const state = { options: { dedupeSettlementNotices: true }, stats: { suppressedNotices: 0 } };
  assert.equal(T.ensureGuard(localCtx, state), "pending");
  assert.equal(T.ensureGuard(localCtx, { ...state, guard: undefined }), "pending");
  const real = { continuations: { activations: {} } };
  assert.equal(T.ensureGuard({ get: (n) => (n === "subagents" ? real : undefined) }, { options: { dedupeSettlementNotices: true }, stats: { suppressedNotices: 0 } }), "unsupported");
});

await check("P5: the detached replica passes the persisted format version through", async () => {
  const prepared = [];
  const savedSessions = services.sessions;
  const savedPersistence = services.sessionPersistence;
  services.sessions = {
    get: () => undefined,
    prepare: (id, options) => {
      prepared.push(options.meta);
      return { seq: 0, eventAt: () => undefined, requestHeader: () => undefined };
    }
  };
  const header = { version: 5, id: "cold-1", createdAt: 1234.5, isSeeded: false };
  services.sessionPersistence = {
    open: async () => ({ header, inheritedEventCount: 0, async read() { return { events: [{ type: "turn/start", seq: 0, data: { turn: 1 } }] }; }, async close() {} })
  };
  try {
    await T.measureMember(ctx, { id: "cold-1" }, {}, undefined);
    assert.equal(prepared[0].version, 5, "a future session-format version must pass through, not be pinned to 4");
    assert.ok(Number.isSafeInteger(prepared[0].createdAt), "a non-integer createdAt must fall back to a safe integer");
  } finally {
    services.sessions = savedSessions;
    services.sessionPersistence = savedPersistence;
  }
});

await check("P6a: withTimeout preserves a real failure instead of resolving it", async () => {
  await assert.rejects(() => T.withTimeout(Promise.reject(new Error("drain failed")), 1000), /drain failed/);
  assert.equal(await T.withTimeout(Promise.resolve("ok"), 1000), "ok");
  await assert.rejects(() => T.withTimeout(new Promise(() => {}), 30), /timed out/);
});

await check("P6b: a member may be renamed back to its own former name", async () => {
  const first = await runTool(lead, "team_member_edit", { target: "reviewer", action: "rename", value: "alpha-one" });
  assert.ok(first.record.formerNames.includes("task-runner") || first.record.formerNames.length > 0);
  const back = await runTool(lead, "team_member_edit", { target: "reviewer", action: "rename", value: "task-runner" });
  assert.equal(back.record.alias, "task-runner", "reverting a rename must be allowed (deliberate: rename is reversible)");
});

await check("P6c: only UUID / session-N shapes are treated as session ids", () => {
  assert.equal(T.looksLikeSessionId("abcdef0123456789"), false, "a bare hex run must not be mistaken for an id");
  assert.equal(T.looksLikeSessionId("abcdef01-2345-6789-abcd-ef0123456789"), true);
  assert.equal(T.looksLikeSessionId("session-42"), true);
  assert.equal(T.looksLikeSessionId("reviewer"), false);
});

await check("P6d: reassign reports the task hand-over explicitly", async () => {
  const ok = await runTool(lead, "team_member_edit", { target: "reviewer", action: "reassign", message: "next: verify docs", task_id: "task-9" });
  assert.deepEqual(ok.taskHandover, { attempted: true, ok: true, reason: null });
  const saved = teamService.updateTask;
  teamService.updateTask = async () => {
    throw new Error("TEAM_TASK_STALE_REVISION");
  };
  try {
    const bad = await runTool(lead, "team_member_edit", { target: "reviewer", action: "reassign", message: "next: retry", task_id: "task-9" });
    assert.equal(bad.taskHandover.attempted, true);
    assert.equal(bad.taskHandover.ok, false, "a failed claim must be visible, not buried in warnings");
    assert.match(bad.taskHandover.reason, /STALE_REVISION/);
    assert.ok(bad.effects.some((effect) => effect.includes("brief delivered")), "the brief still goes out");
  } finally {
    teamService.updateTask = saved;
  }
  const none = await runTool(lead, "team_member_edit", { target: "reviewer", action: "rebrief", message: "no task" });
  assert.deepEqual(none.taskHandover, { attempted: false, ok: false, reason: null });
});

await check("the delete guard also covers a deleted member addressed by session id", async () => {
  // Hole found in review: a deleted member that is still resident used to
  // resolve through the live-agent shortcut into the unguarded child channel.
  T.updateMemberRecord("lead-1", "reviewer", (current) => ({ ...current, deleted: true, deletedAt: "now" }));
  try {
    const membership = { root: lead, id: "lead-1", role: "lead", name: "lead" };
    const refusal = T.deletedMemberById(ctx, lead, "rev-1");
    assert.match(String(refusal), /was deleted/);
    assert.equal(T.deletedMemberById(ctx, lead, "child-z"), undefined, "a non-roster child has no tombstone");
    await assert.rejects(() => runTool(lead, "team_message", { target: "rev-1", message: "hi" }), /was deleted/, "addressing by durable id must be refused");
    // resolving the same id must now go through the roster branch, not the child shortcut
    assert.throws(() => T.resolveTarget(ctx, lead, membership, rows, "rev-1"), /was deleted/);
  } finally {
    T.updateMemberRecord("lead-1", "reviewer", (current) => ({ ...current, deleted: false }));
  }
});

await check("the sidecar read cache validates by mtime+size and refreshes on write", () => {
  const first = T.readStore("lead-1");
  const second = T.readStore("lead-1");
  assert.equal(first, second, "an unchanged file must be served from the cache");
  T.updateMemberRecord("lead-1", "cache-probe", () => ({ alias: "cached" }));
  const third = T.readStore("lead-1");
  assert.notEqual(third, second, "a write must invalidate the cached value");
  assert.equal(third.members["cache-probe"].alias, "cached");
  // an external edit must also invalidate it (size changes)
  T.writeStore("lead-1", { ...T.readStore("lead-1"), members: { ...T.readStore("lead-1").members, external: { alias: "outside" } } });
  assert.equal(T.readStore("lead-1").members.external.alias, "outside");
});

await check("include_pressure: false skips the O(members) session work", async () => {
  const prepared = [];
  const savedSessions = services.sessions;
  services.sessions = { get: () => undefined, prepare: (id) => { prepared.push(id); throw new Error("must not be called"); } };
  try {
    const payload = await runTool(lead, "team_overview", { include_pressure: false, include_settlements: false, include_children: false });
    const member = payload.members.find((entry) => entry.role === "teammate");
    assert.equal(member.contextPressure.known, false);
    assert.equal(member.contextPressure.source, "skipped");
    assert.deepEqual(prepared, [], "no detached replay may run when pressure is skipped");
  } finally {
    services.sessions = savedSessions;
  }
});

await check("the ledger scan is cached and recomputed only when the log grows", () => {
  const calls = { count: 0 };
  const events = [{ type: "user/message", seq: 0, data: { content: [{ type: "text", text: "x" }], source: { kind: "subagent-settled", form: "notice", summary: "s", senderSessionId: "c" } } }];
  const session = {
    seq: 1,
    eventAt(index) {
      calls.count += 1;
      return events[index];
    }
  };
  const first = T.settlementLedger(session, 10);
  const afterFirst = calls.count;
  const second = T.settlementLedger(session, 10);
  assert.deepEqual(second, first);
  assert.equal(calls.count, afterFirst, "an unchanged seq must not rescan the log");
  events.push({ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "y" }], source: { kind: "subagent-settled", form: "notice", summary: "s2", senderSessionId: "c" } } });
  session.seq = 2;
  const third = T.settlementLedger(session, 10);
  assert.equal(third.total, 2, "a grown log must be rescanned");
  assert.ok(calls.count > afterFirst);
});

await check("every member scope shares one set of tool definitions", () => {
  assert.equal(
    lead.__registered.get("team_overview"),
    reviewer.__registered.get("team_overview"),
    "the same definition object must serve every scope (built once, not per member)"
  );
  assert.equal(lead.__registered.size, 9);
  assert.equal(reviewer.__registered.size, 9);
});

await check("the status route survives a cold boot where webServer binds late", async () => {
  // Production failure this reproduces: at a cold boot the profile mounts this
  // plugin before `webServer` binds; apply() runs once, so the route never
  // existed and `/dsh-team-conductor/status` answered 404 while the plugin was
  // perfectly healthy. It only ever worked under hot reload, where webServer was
  // already published.
  const localRoutes = new Map();
  const localListeners = [];
  const localAgent = makeAgent("cold-lead");
  const localServices = {
    agents: { list: () => [localAgent], get: (id) => (id === "cold-lead" ? localAgent : undefined) },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} }
  };
  const localCtx = {
    get: (name) => localServices[name],
    on: (event, callback) => {
      localListeners.push({ event, callback });
      return () => {};
    },
    effect: (factory) => {
      factory();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} }
  };
  mod.apply(localCtx, {});
  assert.equal(localRoutes.size, 0, "no route can exist before webServer binds");
  localServices.webServer = {
    register: (route) => {
      localRoutes.set(route.path, route);
      return () => localRoutes.delete(route.path);
    }
  };
  for (const listener of localListeners.filter((entry) => entry.event === "internal/service")) {
    listener.callback("webServer", localServices.webServer);
  }
  assert.equal(localRoutes.has(T.STATUS_ROUTE), true, "the internal/service hook must register the route when webServer appears");
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload;
    }
  };
  localRoutes.get(T.STATUS_ROUTE).handler({ method: "GET", headers: {} }, res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.statusRoute, "active", "the route must report itself as active");
});

// 12. status route
await check("the loopback status route answers", async () => {
  const route = routes.get(T.STATUS_ROUTE);
  assert.ok(route, "status route was not registered");
  const body = await callStatus();
  assert.equal(body.statusCode, 200);
  assert.equal(body.payload.ok, true);
  assert.equal(body.payload.plugin, T.PLUGIN_ID);
  assert.deepEqual(body.payload.tools.slice().sort(), ["team_capacity_set", "team_member_add", "team_member_delete", "team_member_edit", "team_message", "team_overview", "team_task_add", "team_task_list", "team_task_update"]);
  assert.equal(body.payload.teamService, true);
  assert.equal(body.payload.settlementGuard, "active");
  assert.equal(body.payload.settlementGuardScope, "subagents.continuations.activations");
  assert.equal(body.payload.suppressedNotices, 1);
  assert.equal(body.payload.deleteGuard, "active");
  assert.equal(body.payload.deleteGuardScope, "plugin");
});

await check("the browser half can report that it loaded", async () => {
  // A client bundle is registered by the host at composition time, so a file on
  // disk proves nothing about whether the page ever received it. The client half
  // POSTs to this route once it has applied, and the status route exposes it.
  const before = await callStatus();
  assert.equal(before.payload.clientHalf, "absent");
  const route = routes.get(T.CLIENT_HELLO_ROUTE);
  assert.ok(route, "client-hello route must be registered alongside the status route");
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end() {}
  };
  route.handler({ method: "POST", headers: { "user-agent": "smoke" } }, res);
  assert.equal(res.statusCode, 200);
  const after = await callStatus();
  assert.notEqual(after.payload.clientHalf, "absent", "the status route must record the client half's visit");
  // non-POST is rejected
  const rejected = { statusCode: 0, headers: {}, setHeader() {}, end() {} };
  route.handler({ method: "GET", headers: {} }, rejected);
  assert.equal(rejected.statusCode, 405);
});

await check("the team snapshot route feeds the sidebar panel", () => {
  const route = routes.get(T.TEAM_ROUTE);
  assert.ok(route, "team route must be registered alongside the status route");
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.body = payload;
    }
  };
  route.handler({ method: "GET", headers: {} }, res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.version, "string");
  // Every live Team is returned, so the panel works from any session — a panel
  // pinned to "the first Lead" was wrong whenever another session was open.
  assert.ok(Array.isArray(payload.teams) && payload.teams.length >= 1);
  assert.equal(payload.selected.root, payload.teams[0].root);
  assert.equal(payload.sessionId, null);
  const team = payload.teams[0];
  assert.equal(team.ok, true);
  assert.ok(team.capacity.used >= 1, `expected at least one teammate, got ${team.capacity.used}`);
  assert.equal(team.capacity.max, team.capacity.used + team.capacity.free);
  assert.ok(Array.isArray(team.members) && team.members.length >= 2);
  const member = team.members.find((entry) => entry.role === "teammate");
  assert.equal(member.availability, "idle-ready", "an inactive, unretired member is reusable");
  assert.equal(member.displayName, member.alias ?? member.target);

  // ?session= narrows to one team
  const scoped = { statusCode: 0, headers: {}, body: "", setHeader() {}, end(value) { this.body = value; } };
  route.handler({ method: "GET", headers: {}, url: `${T.TEAM_ROUTE}?session=${team.root}` }, scoped);
  const scopedPayload = JSON.parse(scoped.body);
  assert.equal(scopedPayload.teams.length, 1);
  assert.equal(scopedPayload.sessionId, team.root);
  assert.equal(scopedPayload.mismatch, false);

  // An unknown session must not silently fall back to a different team.
  const missing = { statusCode: 0, headers: {}, body: "", setHeader() {}, end(value) { this.body = value; } };
  route.handler({ method: "GET", headers: {}, url: `${T.TEAM_ROUTE}?session=session-00000000-0000-0000-0000-000000000000` }, missing);
  const missingPayload = JSON.parse(missing.body);
  assert.equal(missingPayload.teams.length, 0);
  assert.equal(missingPayload.mismatch, true);

  const rejected = { statusCode: 0, headers: {}, setHeader() {}, end() {} };
  route.handler({ method: "POST", headers: {} }, rejected);
  assert.equal(rejected.statusCode, 405);
});

await check("the console action route dispatches to the real tool", async () => {
  const route = routes.get(T.ACTION_ROUTE);
  assert.ok(route, "action route must be registered alongside the snapshot route");

  const invoke = async (payload) => {
    const listeners = new Map();
    const req = {
      method: "POST",
      headers: {},
      on(event, callback) {
        listeners.set(event, callback);
        return req;
      }
    };
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      setHeader() {},
      end(value) {
        this.body = value;
      }
    };
    route.handler(req, res);
    listeners.get("data")?.(JSON.stringify(payload));
    listeners.get("end")?.();
    // The handler resolves the tool promise on a later microtask.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return res;
  };

  const raised = await invoke({ tool: "team_capacity_set", args: { max_members: 12 } });
  assert.equal(raised.statusCode, 200);
  const raisedPayload = JSON.parse(raised.body);
  assert.equal(raisedPayload.after, 12, `the UI must reach the same implementation the model does; got ${raised.body}`);
  assert.equal(raisedPayload.configured, 12, "and the double write must still happen");

  const unknown = await invoke({ tool: "spawn_teammate", args: {} });
  assert.equal(unknown.statusCode, 400);
  assert.match(JSON.parse(unknown.body).reason, /unknown tool/);

  const wrongMethod = { statusCode: 0, headers: {}, setHeader() {}, end() {} };
  route.handler({ method: "GET", headers: {} }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
});

await check("the injected policy follows the delegation engine", () => {
  // The model acts on this text, so it must never describe the other engine:
  // "tombstone + ceiling compensation" is simply false under conductor.
  const kernel = T.policyText({ delegationEngine: "kernel" });
  const conductor = T.policyText({ delegationEngine: "conductor" });
  assert.match(kernel, /当前委派引擎：kernel/);
  assert.match(conductor, /当前委派引擎：conductor/);
  assert.match(kernel, /立墓碑/);
  assert.doesNotMatch(conductor, /立墓碑/);
  assert.match(conductor, /还给子代理池/);
  assert.match(conductor, /可立即重建同名成员/);
  assert.doesNotMatch(kernel, /可立即重建同名成员/);
  // The model must map "agent team" onto THIS plugin, and must not be pointed at
  // the kernel tools that no longer exist in this composition.
  for (const text of [kernel, conductor]) {
    assert.match(text, /触发词 → 必用本插件/, "the trigger mapping must be present for both engines");
    assert.match(text, /spawn_teammate/, "the disabled kernel tools must be named so the model stops looking for them");
    assert.match(text, /team_overview/, "the correct first call must be named");
  }
});

await check("the conductor engine spawns and drains its own roster", async () => {
  // The whole point of the second engine: members are ordinary continuable
  // subagents, the roster is ours, and removing one returns its slot to the
  // subagent pool instead of burning a permanent kernel roster entry.
  const spawned = [];
  const drained = [];
  const selected = [];
  const interrupted = [];
  const lead = makeAgent("cond-lead");
  const services = {
    agents: { list: () => [lead], get: (id) => (id === "cond-lead" ? lead : undefined) },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    sessionController: {
      async selectModel(request) {
        selected.push(request);
        return request;
      }
    },
    subagents: {
      interrupt(target, authority) {
        interrupted.push({ target, authority });
      },
      async startContinuable(spec) {
        const childId = `child-${spawned.length + 1}`;
        spawned.push({ spec, childId });
        return { childId, messageId: `msg-${spawned.length}` };
      },
      async drainContinuableChildren(_parent, ids) {
        drained.push(...ids);
      }
    }
  };
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (factory) => {
      factory();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} }
  };
  mod.apply(ctx, { delegationEngine: "conductor" });

  const valueOf = async (tool, args) => {
    const result = await tool.execute(args, { agent: lead });
    return typeof result?.text === "string" ? JSON.parse(result.text) : result;
  };

  const add = lead.__registered.get("team_member_add");
  const created = await valueOf(add, { name: "alpha", description: "does things", brief: "start working" });
  assert.equal(created.engine, "conductor");
  assert.equal(spawned.length, 1, "the member must be a freshly spawned continuable subagent");
  assert.equal(spawned[0].spec.provider, "spawn");
  assert.equal(spawned[0].spec.request.parent, lead, "the Lead must be the delegation parent");
  // The subagent panel renders `label ?? id` as the row title, so the label is the
  // only place a durable team member can be told apart from an ad-hoc subagent.
  assert.equal(spawned[0].spec.label, "Agent Team · alpha", "the row label must carry the team marker");
  // The prompt must be CONTENT BLOCKS: a bare string is spread per character by
  // the seam, which killed the first live spawn with
  // "DeepSeek Messages cannot represent user/tool-result content undefined".
  assert.deepEqual(spawned[0].spec.request.prompt, [{ type: "text", text: "start working" }]);
  assert.equal(created.member.id, spawned[0].childId, "the child id is the member's durable address");

  const overview = await valueOf(lead.__registered.get("team_overview"), { include_pressure: false });
  assert.ok(overview.members.some((member) => member.target === "alpha"), "the conductor roster must list it");
  assert.equal(overview.team.capacity.used, 1);

  // Model, both ways: chosen at spawn time (agentOptions) and switched later
  // through sessionController.selectModel — the same seam the GUI uses.
  const spawnedWithModel = await valueOf(add, {
    name: "beta",
    brief: "start",
    model: "deepseek-account/deepseek-flash"
  });
  assert.deepEqual(
    spawned[1].spec.request.agentOptions,
    { provider: "deepseek-account", model: "deepseek-flash" },
    "a model given at spawn time must reach agentOptions"
  );
  assert.equal(spawnedWithModel.engine, "conductor");
  const switched = await valueOf(lead.__registered.get("team_member_edit"), {
    target: "alpha",
    action: "model",
    value: "deepseek-account/deepseek-v4"
  });
  assert.equal(selected.length, 1, "changing a member's model must call the session controller");
  assert.equal(selected[0].sessionId, "child-1", "it must target the member's own session");
  assert.equal(selected[0].provider, "deepseek-account");
  assert.equal(selected[0].model, "deepseek-v4");
  assert.ok(switched.effects.some((effect) => effect.includes("model switched")), "the switch must be reported");
  // A bare model name inherits the provider instead of inventing one.
  await valueOf(add, { name: "gamma", brief: "start", model: "deepseek-flash" });
  assert.deepEqual(spawned[2].spec.request.agentOptions, { model: "deepseek-flash" });

  // Engine-specific semantics: no kernel ceiling exists here, so capacity_set
  // explains instead of throwing (throwing would read as "something broke"), and
  // capacity reporting must not pretend the kernel's 8 applies.
  const capacityResult = await valueOf(lead.__registered.get("team_capacity_set"), { max_members: 3 });
  assert.equal(capacityResult.applied, false);
  assert.equal(capacityResult.engine, "conductor");
  assert.match(capacityResult.detail, /no member ceiling/);
  const overviewEngine = await valueOf(lead.__registered.get("team_overview"), { include_pressure: false });
  assert.equal(overviewEngine.team.capacity.engine, "conductor");
  assert.equal(overviewEngine.team.capacity.configured, null, "the kernel's configurable ceiling does not apply");
  assert.notEqual(overviewEngine.team.capacity.max, 8, "the kernel fallback must not be reported as the limit");

  // interrupt goes straight to the subagent seam under this engine.
  await valueOf(lead.__registered.get("team_member_edit"), { target: "alpha", action: "interrupt" });
  assert.equal(interrupted.length, 1, "interrupt must reach subagents.interrupt");
  assert.equal(interrupted[0].target, "child-1");
  assert.deepEqual(interrupted[0].authority, { kind: "user", parentSessionId: "cond-lead" });

  const removed = await valueOf(lead.__registered.get("team_member_delete"), { target: "alpha" });
  assert.equal(removed.deleted.engine, "conductor");
  assert.deepEqual(drained, ["child-1"], "deleting must drain the child so the pool slot returns");
  assert.equal(removed.capacity, null, "no ceiling compensation is needed in this engine");

  // The name is free again — impossible with the kernel roster.
  const beforeRecreate = spawned.length;
  const recreated = await valueOf(add, { name: "alpha", description: "again", brief: "second life" });
  assert.equal(recreated.member.id, spawned[beforeRecreate].childId, "the reused name must spawn a NEW child");
  assert.equal(spawned.length, beforeRecreate + 1, "a reused name spawns exactly one new child");
});

await check("the task board enforces dependencies, revisions and overlap warnings", async () => {
  const lead = makeAgent("board-lead");
  const services = {
    agents: { list: () => [lead], get: () => lead },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: {
      async startContinuable() {
        return { childId: "board-child", messageId: "m" };
      },
      async drainContinuableChildren() {},
      async sendMessage() {
        return "m";
      }
    }
  };
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (factory) => {
      factory();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} }
  };
  mod.apply(ctx, { delegationEngine: "conductor" });
  const call = async (name, args) => {
    const raw = await lead.__registered.get(name).execute(args, { agent: lead });
    return typeof raw?.text === "string" ? JSON.parse(raw.text) : raw;
  };

  const first = await call("team_task_add", { title: "first", files: ["src/a.js"] });
  assert.equal(first.task.revision, 1);
  assert.equal(first.task.status, "pending");
  const second = await call("team_task_add", { title: "second", deps: [first.task.id] });

  // A blocked task cannot be claimed; the error names the blocker.
  await assert.rejects(
    () => call("team_task_update", { task_id: second.task.id, action: "claim", expected_revision: second.task.revision }),
    /blocked by t1/
  );
  // Compare-and-set: stale and missing revisions are both refused.
  await assert.rejects(
    () => call("team_task_update", { task_id: first.task.id, action: "claim", expected_revision: 99 }),
    /changed since revision 99/
  );
  await assert.rejects(
    () => call("team_task_update", { task_id: first.task.id, action: "claim" }),
    /expected_revision is required/
  );

  const claimed = await call("team_task_update", { task_id: first.task.id, action: "claim", expected_revision: first.task.revision });
  assert.equal(claimed.task.status, "in_progress");
  assert.equal(claimed.task.revision, 2, "every mutation bumps the revision");

  // File hints that overlap an in-progress task produce a warning, never a veto.
  const third = await call("team_task_add", { title: "third", files: ["src/a.js/deep.js"] });
  const thirdClaimed = await call("team_task_update", { task_id: third.task.id, action: "claim", expected_revision: third.task.revision });
  assert.equal(thirdClaimed.task.status, "in_progress", "overlap must not block the claim");
  assert.ok(thirdClaimed.warnings.some((warning) => warning.includes("overlaps")), "overlap must be reported");
  const board = await call("team_task_list", {});
  assert.ok(board.warnings.some((warning) => warning.includes("touches files")), "the board must repeat the overlap warning");

  // Completing the dependency unblocks the dependent task.
  await call("team_task_update", { task_id: first.task.id, action: "complete", expected_revision: claimed.task.revision });
  const secondClaimed = await call("team_task_update", { task_id: second.task.id, action: "claim", expected_revision: second.task.revision });
  assert.equal(secondClaimed.task.status, "in_progress");

  // Path overlap is the documented prefix rule.
  assert.equal(T.pathsOverlap("src/a.js", "src/a.js"), true);
  assert.equal(T.pathsOverlap("src/a", "src/a/b.js"), true);
  assert.equal(T.pathsOverlap("src/a.js", "src/b.js"), false);
});

await check("the dispatcher hands a ready task to an idle member and rolls back a failed wake", async () => {
  const sent = [];
  const lead = makeAgent("dispatch-lead");
  let failSend = false;
  const services = {
    agents: { list: () => [lead], get: () => lead },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: {
      async startContinuable() {
        return { childId: "dispatch-child", messageId: "m" };
      },
      async drainContinuableChildren() {},
      async sendMessage(_sender, id, content) {
        if (failSend) throw new Error("delivery unavailable");
        sent.push({ id, content });
        return "m";
      }
    }
  };
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (factory) => {
      factory();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} }
  };
  const options = { delegationEngine: "conductor", autoAssign: { enabled: true, intervalMs: 15000, maxPerTick: 1 } };
  mod.apply(ctx, options);
  const call = async (name, args) => {
    const raw = await lead.__registered.get(name).execute(args, { agent: lead });
    return typeof raw?.text === "string" ? JSON.parse(raw.text) : raw;
  };

  await call("team_member_add", { name: "worker", brief: "wait for tasks" });
  await call("team_task_add", { title: "do the thing" });

  const state = { options, stats: {} };
  const tick = await T.autoAssignTick(ctx, state);
  assert.equal(tick.assigned, 1, "one task must be handed out");
  assert.equal(sent.length, 1, "the member must be woken with a brief");
  assert.match(JSON.stringify(sent[0].content), /shared task t1/, "the brief must name the task");
  const after = await call("team_task_list", {});
  const claimed = after.tasks.find((entry) => entry.id === "t1");
  assert.equal(claimed.owner, "worker");
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.assignedBy, "auto");

  // A second tick finds nothing: the only task is already owned.
  const second = await T.autoAssignTick(ctx, state);
  assert.equal(second.assigned, 0);

  // A failed wake must roll the claim back so the task is not stuck in_progress.
  const task2 = await call("team_task_add", { title: "second thing" });
  failSend = true;
  const third = await T.autoAssignTick(ctx, state);
  assert.equal(third.assigned, 0, "a failed wake reports no assignment");
  const board = await call("team_task_list", {});
  const rolled = board.tasks.find((entry) => entry.id === task2.task.id);
  assert.equal(rolled.status, "pending", "the claim must be released when the member cannot be woken");
  assert.equal(rolled.owner, null);

  // --- "做完一个任务后会不会自动接下一个" ---
  // Delivery is back. The worker still owns t1 (in_progress) and its turn has
  // ended, so a naive dispatcher would hand it t2 immediately: board-level busy
  // must prevent that, otherwise work stacks on a half-done task.
  failSend = false;
  const whileBusy = await T.autoAssignTick(ctx, state);
  assert.equal(whileBusy.assigned, 0, "a member that still owns an unfinished task is not free");
  const stillPending = (await call("team_task_list", {})).tasks.find((entry) => entry.id === task2.task.id);
  assert.equal(stillPending.status, "pending");
  assert.equal(stillPending.owner, null);

  // The member finishes t1 the way the brief tells it to: complete it. (The claim
  // half must be a no-op — the dispatcher already claimed it in this member's name.)
  const list = await call("team_task_list", {});
  const t1 = list.tasks.find((entry) => entry.id === "t1");
  // The member's own claim is a no-op (the dispatcher already claimed it for them).
  // `by` is the caller identity, so this is checked as the member, not as the Lead.
  const reclaimed = T.mutateTask(lead.id, T.readStore(lead.id), { taskId: "t1", action: "claim", expectedRevision: t1.revision }, "worker");
  assert.equal(reclaimed.owner, "worker", "re-claiming as the current owner is a no-op, not an error");
  // The Lead still may not steal a task owned by a member — that stays an error.
  assert.throws(
    () => T.mutateTask(lead.id, T.readStore(lead.id), { taskId: "t1", action: "claim", expectedRevision: reclaimed.revision }, "lead"),
    /is owned by "worker"/,
    "claiming someone else's task must still be refused"
  );
  await call("team_task_update", { task_id: "t1", action: "complete", expected_revision: reclaimed.revision });

  // Now the worker is free again, and the next tick hands it the next task.
  const next = await T.autoAssignTick(ctx, state);
  assert.equal(next.assigned, 1, "once the previous task is done the member picks up the next one");
  const board2 = await call("team_task_list", {});
  const t2 = board2.tasks.find((entry) => entry.id === task2.task.id);
  assert.equal(t2.owner, "worker");
  assert.equal(t2.assignedBy, "auto");
  assert.equal(state.stats.autoAssigned, 2, "two tasks were handed out by the dispatcher");
  // The brief must not ask for a claim that would now throw (owner !== null).
  assert.match(JSON.stringify(sent.at(-1).content), /already claimed in your name/);
  assert.doesNotMatch(JSON.stringify(sent.at(-1).content), /Claim it before starting/);
});

await check("a member conversation shows its Lead's team, not a team of its own", async () => {
  // The panel is scoped by session id, and inside a member's conversation that id
  // is the CHILD session. Matching it verbatim found no team and made every UI
  // action fail with "no live Team member", so the child must resolve upwards.
  const spawned = [];
  const lead = makeAgent("root-lead");
  const child = makeAgent("child-session-1", { parent: "root-lead" });
  const live = [lead, child];
  const services = {
    agents: { list: () => live, get: (id) => live.find((agent) => agent.id === id) },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: {
      async startContinuable(spec) {
        spawned.push(spec);
        return { childId: "child-session-1", messageId: "m" };
      },
      async drainContinuableChildren() {},
      async sendMessage() {
        return "m";
      }
    }
  };
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (factory) => {
      factory();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} }
  };
  const options = { delegationEngine: "conductor" };
  mod.apply(ctx, options);
  const call = async (name, args) => {
    const raw = await lead.__registered.get(name).execute(args, { agent: lead });
    return typeof raw?.text === "string" ? JSON.parse(raw.text) : raw;
  };
  await call("team_member_add", { name: "alpha", brief: "work" });

  // Asked with the child id, the snapshot answers with the Lead's team.
  const opts = T.normalizeOptions(ctx, options);
  const viaChild = T.teamsSnapshot(ctx, "child-session-1", opts);
  assert.equal(viaChild.teams.length, 1, "the child must resolve to its Lead's team");
  assert.equal(viaChild.sessionId, "root-lead", "sessionId reports the Team root");
  assert.equal(viaChild.requestedSessionId, "child-session-1");
  assert.equal(viaChild.resolvedFrom, "live");
  assert.equal(viaChild.mismatch, false);
  assert.equal(viaChild.teams[0].members.some((member) => member.target === "alpha"), true, `the roster must list alpha: ${JSON.stringify(viaChild.teams[0].members.map((member) => member.target))}`);

  // UI actions issued from the child conversation target the Lead.
  assert.equal(T.pickCaller(ctx, "child-session-1")?.id, "root-lead");

  // A dormant member is not a live agent: the sidecar still knows its child id.
  live.length = 0;
  live.push(lead);
  const viaSidecar = T.teamsSnapshot(ctx, "child-session-1", opts);
  assert.equal(viaSidecar.resolvedFrom, "sidecar", "the roster record is the fallback");
  assert.equal(viaSidecar.teams.length, 1);

  // An unknown session stays a honest mismatch instead of borrowing another team.
  const unknown = T.teamsSnapshot(ctx, "not-a-session", opts);
  assert.equal(unknown.teams.length, 0);
  assert.equal(unknown.mismatch, true);
});

await check("auto-assign is on by default and can be turned off explicitly", () => {
  // normalizeOptions(ctx, config) — the ctx comes first.
  const quiet = { logger: { info: () => {}, warn: () => {} } };
  assert.equal(T.normalizeOptions(quiet, {}).autoAssign.enabled, true, "the dispatcher is on by default");
  assert.equal(T.normalizeOptions(quiet, { autoAssign: {} }).autoAssign.enabled, true);
  assert.equal(T.normalizeOptions(quiet, { autoAssign: { enabled: false } }).autoAssign.enabled, false, "explicit false still disables");
});

await check("legacy kernel tool names forward to this plugin", async () => {
  // Prompts, skills and older docs still say spawn_teammate / send_message /
  // team_task_create. Registering those names as aliases means such a reference
  // lands here instead of failing with "unknown tool".
  const spawned = [];
  const sent = [];
  const lead = makeAgent("alias-lead");
  const services = {
    agents: { list: () => [lead], get: () => lead },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: {
      async startContinuable(spec) {
        spawned.push(spec);
        return { childId: `alias-child-${spawned.length}`, messageId: "m" };
      },
      async drainContinuableChildren() {},
      async sendMessage(_sender, id, content) {
        sent.push({ id, content });
        return "m";
      }
    }
  };
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (factory) => {
      factory();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} }
  };
  mod.apply(ctx, { delegationEngine: "conductor" });
  const call = async (name, args) => {
    const tool = lead.__registered.get(name);
    assert.ok(tool, `${name} must be registered under the conductor engine`);
    const raw = await tool.execute(args, { agent: lead });
    return typeof raw?.text === "string" ? JSON.parse(raw.text) : raw;
  };

  // The kernel's spawn_teammate schema, verbatim.
  const created = await call("spawn_teammate", { name: "legacy", description: "built from old name", prompt: "do the old thing" });
  assert.equal(created.engine, "conductor");
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].request.prompt, [{ type: "text", text: "do the old thing" }], "prompt must map to brief, as content blocks");

  // send_message -> team_message
  await call("send_message", { target: "legacy", message: "hello" });
  assert.equal(sent.length, 1, "send_message must reach the member");
  assert.match(JSON.stringify(sent[0].content), /hello/);

  // list_agents -> team_overview (no pressure measurement)
  const listed = await call("list_agents", {});
  assert.ok(Array.isArray(listed.members), "list_agents must return a roster");

  // team_task_create -> team_task_add with the kernel's argument names
  const task = await call("team_task_create", { subject: "old style task", description: "d", write_scopes: ["src/x.js"] });
  assert.equal(task.task.title, "old style task");
  assert.deepEqual(task.task.files, ["src/x.js"]);
  assert.equal(task.task.details, "d");

  // wait_agent must not throw; it points at re-reading instead of blocking.
  const waited = await call("wait_agent", { timeout_ms: 1000 });
  assert.equal(waited.ok, true);
  assert.match(waited.note, /team_overview|team_task_list/);

  // Aliases are conductor-only: under the kernel engine those names still belong
  // to the kernel bundle, so registering them again would collide.
  const kernelTools = T.buildTools(ctx, { delegationEngine: "kernel", legacyAliases: true }, { stats: {} });
  assert.equal(kernelTools.some((tool) => tool.name === "spawn_teammate"), false, "kernel engine must not alias");
});

await check("reassign hands over our own task board, and retire releases the activation", async () => {
  // Both used to depend on the kernel service: reassign skipped the hand-over
  // ("task board unavailable") and retire only set a flag, so a conductor member
  // kept running after being retired.
  const spawned = [];
  const drained = [];
  const interrupted = [];
  const lead = makeAgent("life-lead");
  const services = {
    agents: { list: () => [lead], get: () => lead },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    subagents: {
      async startContinuable(spec) {
        spawned.push(spec);
        return { childId: `life-child-${spawned.length}`, messageId: "m" };
      },
      async drainContinuableChildren(_parent, ids) {
        drained.push(...ids);
      },
      interrupt(target, authority) {
        interrupted.push({ target, authority });
      },
      async sendMessage() {
        return "m";
      }
    }
  };
  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    effect: (factory) => {
      factory();
      return () => {};
    },
    logger: { info: () => {}, warn: () => {} }
  };
  mod.apply(ctx, { delegationEngine: "conductor" });
  const call = async (name, args) => {
    const raw = await lead.__registered.get(name).execute(args, { agent: lead });
    return typeof raw?.text === "string" ? JSON.parse(raw.text) : raw;
  };

  await call("team_member_add", { name: "alpha", brief: "start" });
  await call("team_task_add", { title: "work to hand over" });

  const handed = await call("team_member_edit", {
    target: "alpha",
    action: "reassign",
    value: "beta",
    message: "take the next piece",
    task_id: "t1"
  });
  assert.equal(handed.taskHandover.ok, true, `the hand-over must succeed on our own board (${JSON.stringify(handed.taskHandover)})`);
  const board = await call("team_task_list", {});
  const task = board.tasks.find((entry) => entry.id === "t1");
  assert.equal(task.owner, "beta", "the task must be owned by the new name");
  assert.ok(handed.effects.some((effect) => effect.includes("conductor board")), "the effect must say which board it used");

  const retired = await call("team_member_edit", { target: "beta", action: "retire" });
  assert.ok(retired.effects.some((effect) => effect.includes("retired")), "retire must report itself");
  assert.ok(drained.length >= 1, "retire must release the live activation through the subagent seam");
  assert.equal(interrupted.length >= 1, true, "retire must interrupt a running turn");

  // restore is still available and clears the flag without needing the session back
  const restored = await call("team_member_edit", { target: "beta", action: "restore" });
  assert.ok(Array.isArray(restored.effects), "restore must answer with effects");
});

await check("new agents get the tools installed", () => {



  const created = listeners.find((listener) => listener.event === "agent/created");
  assert.ok(created, "agent/created listener was not registered");
  const late = makeAgent("late-1", { parent: "lead-1" });
  created.callback({ agent: late });
  assert.equal(late.__registered.size, 9);
  const outsider = makeAgent("outsider-1");
  created.callback({ agent: outsider });
  assert.equal(outsider.__registered.size, 0);
});

// ---------------------------------------------------------------------------

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok ? "" : `\n        ${entry.error}`}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
rmSync(HOME, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);