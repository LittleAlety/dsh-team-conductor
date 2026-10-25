#!/usr/bin/env node
/**
 * Post-restart live check for dsh-team-conductor.
 *
 * A host plugin's module is cached by the ESM loader, so updating the code on
 * disk does NOT hot-reload it: the running process keeps the version it first
 * imported. After restarting the Harness, run this to prove the process really
 * picked the new build up — it asserts the status route's contract instead of
 * eyeballing JSON.
 *
 * It is engine aware: under `conductor` or `session` there is no kernel Team service, so
 * `teamService` is false and the deleted-target guard reports `not-applicable`
 * by design. Those are expectations, not failures.
 *
 * Usage:
 *   node scripts/verify-live.mjs                 # default http://127.0.0.1:19387
 *   node scripts/verify-live.mjs http://host:port
 *
 * Exit code 0 = the running process serves the expected build; 1 = mismatch.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] ?? "http://127.0.0.1:19387").replace(/\/+$/u, "");

/** The build on disk — the only authority for "is the process current?". */
const here = dirname(fileURLToPath(import.meta.url));
const onDisk = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

const url = `${base}/dsh-team-conductor/status`;

/** The canonical tool surface this build must expose (aliases are extra). */
const EXPECTED_TOOLS = [
  "team_overview",
  "team_member_edit",
  "team_capacity_set",
  "team_message",
  "team_member_add",
  "team_member_delete",
  "team_task_add",
  "team_task_list",
  "team_task_update"
];
/** Kernel tool names registered as forwarding aliases under the conductor engine. */
const ALIAS_TOOLS = ["spawn_teammate", "send_message", "list_agents", "interrupt_agent", "team_task_create", "team_task_get"];

const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

let payload;
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  check(response.status === 200, `status route returned HTTP ${response.status}`);
  payload = await response.json();
} catch (error) {
  console.error(`FAIL  cannot reach ${url}: ${String(error?.message ?? error)}`);
  console.error("      the plugin is not mounted in the running process, or the Harness is not listening");
  process.exit(1);
}

check(payload?.ok === true, "payload.ok must be true");
check(payload?.plugin === "dsh-team-conductor", `plugin must be dsh-team-conductor, got ${String(payload?.plugin)}`);

const version = String(payload?.version ?? "");
check(/^\d+\.\d+\.\d+/u.test(version), `version must be a semver string, got ${JSON.stringify(version)}`);
// The authoritative freshness check: the running process must serve the build
// that is on disk right now, not an earlier import.
check(version === onDisk, `version mismatch: on disk ${onDisk}, running ${version} — the process is serving an older module; restart the Harness`);

const engine = String(payload?.engine ?? "");
// A build that predates the engine field reports "" — say that plainly instead of
// cascading into misleading guard failures.
const engineKnown = ["kernel", "conductor", "session"].includes(engine);
if (!engineKnown) {
  failures.push(`engine is ${JSON.stringify(engine)}: this build does not report an engine, so the process is running an older module — restart the Harness`);
}

const tools = Array.isArray(payload?.tools) ? [...payload.tools] : [];
// Exact equality would break as soon as aliases are registered, so demand the
// canonical set and (for the conductor engine) the aliases as well.
for (const expected of EXPECTED_TOOLS) check(tools.includes(expected), `missing tool ${expected}`);
if (engine === "conductor" || engine === "session") {
  for (const alias of ALIAS_TOOLS) check(tools.includes(alias), `missing legacy alias ${alias}`);
  notes.push(`${engine} engine: ${tools.length} tools (${EXPECTED_TOOLS.length} canonical + aliases)`);
}
check(payload?.installedAgents >= 1, `installedAgents must be >= 1, got ${String(payload?.installedAgents)}`);

// The kernel Team service only exists under the kernel engine.
if (engine === "kernel") {
  check(payload?.teamService === true, "teamService must be true under the kernel engine (the Agent Teams bundle must be mounted)");
} else {
  check(payload?.teamService === false, `teamService must be false under the ${engine} engine (the kernel roster is disabled)`);
}

// Guard status vocabulary: `active` is the good state; `pending` retries on the
// next tool call; `not-applicable` is expected for the delete guard under the
// conductor engine (there is no kernel sendMessage to wrap); `disabled` is a
// deliberate config off-switch. `unavailable` only ever existed in the first
// build, so seeing it means a stale process.
for (const [key, label] of engineKnown ? [["settlementGuard", "settlement-notice guard"], ["deleteGuard", "deleted-target guard"]] : []) {
  const status = payload?.[key];
  if (status === "unavailable") {
    notes.push(`${label} reports "unavailable" — that value only exists in the first build, so the process predates the update`);
    continue;
  }
  const acceptable = engine === "conductor" || engine === "session"
    ? ["active", "pending", "disabled", "not-applicable"]
    : ["active", "pending", "disabled"];
  check(acceptable.includes(status), `${label} has unexpected status ${JSON.stringify(status)} (engine ${engine})`);
  if (status === "pending") notes.push(`${label} is pending; it retries on the next tool call`);
  if (status === "not-applicable") notes.push(`${label} is not applicable under the ${engine} engine (nothing to wrap)`);
  if (status === "unsupported") failures.push(`${label} reports unsupported — the kernel shape changed (subagents.continuations?.activations)`);
  if (status === "failed") failures.push(`${label} reports failed — check the Harness log for the warning`);
}

const pad = (label) => `${label.padEnd(26)}`;
console.log(`target                     ${url}`);
console.log(`${pad("plugin")}${String(payload.plugin)}`);
console.log(`${pad("version")}${version}${version === onDisk ? "" : `  (on disk: ${onDisk})`}`);
console.log(`${pad("engine")}${engine}`);
console.log(`${pad("tools")}${tools.length === 0 ? "(none)" : tools.join(", ")}`);
console.log(`${pad("teamService")}${String(payload.teamService)}`);
console.log(`${pad("installedAgents")}${String(payload.installedAgents)}`);
console.log(`${pad("settlementGuard")}${String(payload.settlementGuard)}${payload.settlementGuardScope ? ` (${payload.settlementGuardScope})` : ""}`);
console.log(`${pad("deleteGuard")}${String(payload.deleteGuard)}${payload.deleteGuardScope ? ` (${payload.deleteGuardScope})` : ""}`);
console.log(`${pad("suppressedNotices")}${String(payload.suppressedNotices)}`);
console.log(`${pad("blockedDeletedSends")}${String(payload.blockedDeletedSends)}`);
console.log(`${pad("clientHalf")}${String(payload.clientHalf)}`);
console.log(`${pad("store")}${String(payload.store)}`);

for (const note of notes) console.log(`NOTE  ${note}`);
if (failures.length === 0) {
  console.log("\nPASS  the running Harness serves this build on the expected engine");
  process.exit(0);
}
for (const failure of failures) console.log(`FAIL  ${failure}`);
console.log("\nthe on-disk build and the running process disagree — restart the Harness, then re-run");
process.exit(1);
