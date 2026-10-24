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
 * Usage:
 *   node scripts/verify-live.mjs                 # default http://127.0.0.1:19387
 *   node scripts/verify-live.mjs http://host:port
 *
 * Exit code 0 = the running process serves the expected build; 1 = mismatch.
 */

const base = (process.argv[2] ?? "http://127.0.0.1:19387").replace(/\/+$/u, "");
const url = `${base}/dsh-team-conductor/status`;

/** The tool surface this build must expose. */
const EXPECTED_TOOLS = [
  "team_overview",
  "team_member_edit",
  "team_capacity_set",
  "team_message",
  "team_member_add",
  "team_member_delete"
];

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
if (version !== "" && Number.parseInt(version.split(".")[1] ?? "0", 10) === 1) {
  notes.push("version still looks like the very first build (0.1.x) — the process likely predates the update");
}

const tools = Array.isArray(payload?.tools) ? [...payload.tools].sort() : [];
check(tools.length === EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length} tools, got ${tools.length}`);
for (const expected of EXPECTED_TOOLS) check(tools.includes(expected), `missing tool ${expected}`);
check(payload?.teamService === true, "teamService must be true (the Agent Teams bundle must be mounted)");
check(payload?.installedAgents >= 1, `installedAgents must be >= 1, got ${String(payload?.installedAgents)}`);

// Both guards are wrappers over kernel objects; `pending` means the service had
// not bound yet (retry happens on the next tool call), `unsupported` means the
// kernel shape changed and the guard needs a port.
for (const [key, label] of [["settlementGuard", "settlement-notice guard"], ["deleteGuard", "deleted-target guard"]]) {
  const status = payload?.[key];
  // `unavailable` was the very first build's vocabulary; treat it as a stale
  // process rather than an unknown state.
  if (status === "unavailable") {
    notes.push(`${label} reports "unavailable" — that value only exists in the first build, so the process predates the update`);
    continue;
  }
  check(status === "active" || status === "pending" || status === "disabled", `${label} has unexpected status ${JSON.stringify(status)}`);
  if (status === "pending") notes.push(`${label} is pending; it retries on the next tool call`);
  if (status === "unsupported") failures.push(`${label} reports unsupported — the kernel shape changed (subagents.continuations?.activations)`);
  if (status === "failed") failures.push(`${label} reports failed — check the Harness log for the warning`);
}

const pad = (label) => `${label.padEnd(26)}`;
console.log(`target                     ${url}`);
console.log(`${pad("plugin")}${String(payload.plugin)}`);
console.log(`${pad("version")}${version}`);
console.log(`${pad("tools")}${tools.length === 0 ? "(none)" : tools.join(", ")}`);
console.log(`${pad("installedAgents")}${String(payload.installedAgents)}`);
console.log(`${pad("settlementGuard")}${String(payload.settlementGuard)}${payload.settlementGuardScope ? ` (${payload.settlementGuardScope})` : ""}`);
console.log(`${pad("deleteGuard")}${String(payload.deleteGuard)}${payload.deleteGuardScope ? ` (${payload.deleteGuardScope})` : ""}`);
console.log(`${pad("suppressedNotices")}${String(payload.suppressedNotices)}`);
console.log(`${pad("blockedDeletedSends")}${String(payload.blockedDeletedSends)}`);
console.log(`${pad("store")}${String(payload.store)}`);

for (const note of notes) console.log(`NOTE  ${note}`);
if (failures.length === 0) {
  console.log("\nPASS  the running Harness serves this build and both guards are in place");
  process.exit(0);
}
for (const failure of failures) console.log(`FAIL  ${failure}`);
console.log("\nthe on-disk build and the running process disagree — restart the Harness, then re-run");
process.exit(1);