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
  assert.deepEqual(mod.inject, ["agents", "tools", "systemPrompt"]);
  assert.equal(typeof mod.apply, "function");
});

// 2. schema subset, 3. registry contract
await check("every authored schema stays inside the enforced subset", () => {
  const tools = T.buildTools(ctx, { dedupeSettlementNotices: true, maxOverviewNotices: 10 }, { stats: { suppressedNotices: 0 } });
  assert.equal(tools.length, 6);
  for (const definition of tools) {
    const problems = [...subsetViolations(definition.parameters, `${definition.name}.parameters`), ...subsetViolations(T.TEXT_OUTPUT_SCHEMA, `${definition.name}.output`)];
    assert.deepEqual(problems, [], `${definition.name}: ${problems.join("; ")}`);
  }
});

await check("every tool satisfies the registry contract", () => {
  for (const agent of [lead, reviewer]) {
    assert.deepEqual([...agent.__registered.keys()].sort(), ["team_capacity_set", "team_member_add", "team_member_delete", "team_member_edit", "team_message", "team_overview"]);
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
  await assert.rejects(() => runTool(lead, "team_member_add", { name: "x", description: "y" }), /brief is required/);
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

// 11. status route
await check("the loopback status route answers", async () => {
  const route = routes.get(T.STATUS_ROUTE);
  assert.ok(route, "status route was not registered");
  const body = await callStatus();
  assert.equal(body.statusCode, 200);
  assert.equal(body.payload.ok, true);
  assert.equal(body.payload.plugin, T.PLUGIN_ID);
  assert.deepEqual(body.payload.tools.slice().sort(), ["team_capacity_set", "team_member_add", "team_member_delete", "team_member_edit", "team_message", "team_overview"]);
  assert.equal(body.payload.teamService, true);
  assert.equal(body.payload.settlementGuard, "active");
  assert.equal(body.payload.settlementGuardScope, "subagents.continuations.activations");
  assert.equal(body.payload.suppressedNotices, 1);
  assert.equal(body.payload.deleteGuard, "active");
  assert.equal(body.payload.deleteGuardScope, "plugin");
});

await check("new agents get the tools installed", () => {
  const created = listeners.find((listener) => listener.event === "agent/created");
  assert.ok(created, "agent/created listener was not registered");
  const late = makeAgent("late-1", { parent: "lead-1" });
  created.callback({ agent: late });
  assert.equal(late.__registered.size, 6);
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