#!/usr/bin/env node
/** A small terminal front end for the plugin's loopback API. */
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const PREFIX = "/dsh-team-conductor";
const HELP = `dsh-team [--url http://127.0.0.1:PORT] [--session ROOT] [--json] COMMAND

Commands:
  status                     Show host and team health
  teams                      Show every live team
  team [ROOT]                Show roster and task board
  task add TITLE             Create a task
  task assign ID MEMBER      Assign a ready task to a teammate
  task complete ID           Complete a task
  member add NAME [BRIEF]   Add a member
  member message NAME TEXT  Send a message
  member model NAME PROVIDER/MODEL  Switch a member model (also saves global default)
  help                       Show this help

Without a command, an interactive console opens. --json gives a scriptable snapshot.`;

export function parseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid URL: ${value}`); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("--url must be an HTTP loopback origin, such as http://127.0.0.1:19387/");
  }
  return url;
}

export function parseArgs(argv) {
  const options = { url: parseUrl(process.env.DSH_TEAM_URL ?? "http://127.0.0.1:19387/"), session: undefined, json: false, command: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.command = ["help"];
    else if (arg === "--url" || arg === "--session") {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = arg === "--url" ? parseUrl(argv[++i]) : argv[++i];
    } else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else options.command.push(arg);
  }
  return options;
}

async function api(base, path, payload) {
  const url = new URL(`${PREFIX}/${path}`, base);
  const response = await fetch(url, payload === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${path}: invalid JSON from host (${response.status})`); }
  if (!response.ok || data?.ok === false) throw new Error(`${path}: ${data?.reason ?? `HTTP ${response.status}`}`);
  return data;
}

const short = (value) => typeof value === "string" ? value.slice(0, 12) : "?";
/**
 * Fixed-width cell. A truncated value gets an ellipsis instead of being cut
 * mid-word, so a long member name never looks like a different, shorter one.
 */
const label = (value, width) => {
  const full = String(value ?? "");
  if (full.length <= width) return full.padEnd(width);
  return `${full.slice(0, Math.max(0, width - 1))}…`;
};

/** Compact, unambiguous status words for the narrow status column. */
const STATUS = { in_progress: "running", pending: "pending", done: "done" };

export function renderTeam(snapshot) {
  const teams = snapshot?.teams ?? [];
  if (teams.length === 0) return "No live teams.";
  return teams.map((team) => {
    const lines = [`TEAM ${team.root}  members ${team.capacity?.used ?? "?"}/${team.capacity?.max ?? "?"}`];
    lines.push("  MEMBERS");
    for (const member of team.members ?? []) {
      lines.push(`  ${label(member.displayName ?? member.target ?? member.name, 20)} ${label(member.availability ?? member.status, 11)} ${member.contextPressure?.level ?? ""}`.trimEnd());
    }
    if (!(team.members ?? []).length) lines.push("  (none)");
    lines.push("  TASKS");
    for (const task of team.board?.tasks ?? []) {
      const blocked = (task.blockedBy ?? []).length ? ` blocked: ${task.blockedBy.join(",")}` : "";
      lines.push(`  ${label(task.id, 5)} ${label(STATUS[task.status] ?? task.status, 9)} ${label(task.owner ?? "-", 14)} ${task.title}${blocked}`);
    }
    if (!(team.board?.tasks ?? []).length) lines.push("  (none)");
    return lines.join("\n");
  }).join("\n\n");
}

export async function runCommand(options) {
  const [area = "team", verb, ...rest] = options.command;
  if (area === "help") return HELP;
  if (area === "status") return api(options.url, "status");
  if (area === "teams" || area === "team") {
    const session = area === "team" ? verb ?? options.session : undefined;
    const query = session ? `?session=${encodeURIComponent(session)}` : "";
    return api(options.url, `team${query}`);
  }
  if (!options.session) throw new Error("A mutation needs --session ROOT. Run 'teams' to find it.");
  const snapshot = await api(options.url, `team?session=${encodeURIComponent(options.session)}`);
  const team = snapshot.teams?.[0];
  if (!team || snapshot.mismatch === true) throw new Error(`No live team for ${options.session}`);
  const session = team.root;
  let tool;
  let args;
  if (area === "task" && verb === "add") {
    if (!rest.length) throw new Error("task add requires TITLE");
    tool = "team_task_add"; args = { title: rest.join(" ") };
  } else if (area === "task" && ["assign", "complete"].includes(verb)) {
    const id = rest[0];
    const task = team.board?.tasks?.find((entry) => entry.id === id);
    if (!task) throw new Error(`Task ${id ?? "?"} is not on this board`);
    if (verb === "assign") {
      const owner = rest[1];
      if (!owner || !team.members?.some((member) => member.target === owner && member.role === "teammate" && !member.retired && !member.deleted)) throw new Error("task assign requires an active MEMBER from this Team");
      args = { task_id: id, action: "assign", owner, expected_revision: task.revision };
    } else args = { task_id: id, action: verb, expected_revision: task.revision };
    tool = "team_task_update";
  } else if (area === "member" && verb === "add") {
    if (!rest[0]) throw new Error("member add requires NAME");
    tool = "team_member_add"; args = { name: rest[0], brief: rest.slice(1).join(" ") || undefined };
  } else if (area === "member" && verb === "message") {
    if (!rest[0] || rest.length < 2) throw new Error("member message requires NAME and TEXT");
    tool = "team_message"; args = { target: rest[0], message: rest.slice(1).join(" ") };
  } else if (area === "member" && verb === "model") {
    if (!rest[0] || !rest[1] || !rest[1].includes("/")) throw new Error("member model requires NAME and PROVIDER/MODEL");
    tool = "team_member_edit"; args = { target: rest[0], action: "model", value: rest[1] };
  } else throw new Error(`Unknown command: ${options.command.join(" ")}. Run 'help'.`);
  return api(options.url, "action", { tool, args, session });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command.length || options.json || !stdin.isTTY) {
    const value = await runCommand(options);
    stdout.write(typeof value === "string" ? `${value}\n` : options.json ? `${JSON.stringify(value, null, 2)}\n` : options.command[0] === "status" ? `${JSON.stringify(value, null, 2)}\n` : options.command[0] === "team" || options.command[0] === "teams" || !options.command.length ? `${renderTeam(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write("Agent Team console. Type 'help' for commands, 'quit' to leave.\n");
  try {
    for (;;) {
      const line = (await rl.question(`team ${short(options.session)} > `)).trim();
      if (line === "quit" || line === "exit") break;
      if (!line) continue;
      if (line.startsWith("use ")) { options.session = line.slice(4).trim(); continue; }
      options.command = line.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
      try {
        const value = await runCommand(options);
        stdout.write(typeof value === "string" ? `${value}\n` : options.command[0] === "team" || options.command[0] === "teams" ? `${renderTeam(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
      } catch (error) { stderr.write(`Error: ${error.message}\n`); }
    }
  } finally { rl.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
}
