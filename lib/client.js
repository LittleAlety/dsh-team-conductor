/**
 * dsh-team-conductor — browser half.
 *
 * Two contributions:
 *
 *  1. `tool.call.toolview` cards for the six conductor tools — without them
 *     every call falls back to a raw JSON body.
 *  2. A Settings section named "Agent Team": a roster panel that polls the
 *     host's `/dsh-team-conductor/team` snapshot. It lives in Settings because
 *     that is where a user goes to adjust plugins, and the section slot is
 *     declared statically — no navigation service to wait for.
 *
 * Every stage is wrapped and its outcome is POSTed to
 * `/dsh-team-conductor/client-hello`, so a silently rejected contribution can be
 * diagnosed with `curl` instead of by staring at the screen.
 */
window.__ModuleLoader__.load({
  id: "dsh-team-conductor",
  factory: (require) => {
    const React = require("react");

    const TOOL_NAMES = [
      "team_overview",
      "team_member_edit",
      "team_capacity_set",
      "team_message",
      "team_member_add",
      "team_member_delete"
    ];
    const SECTION_ID = "agent-team";
    const SECTION_ORDER = 16;
    const TEAM_ROUTE = "/dsh-team-conductor/team";
    const POLL_MS = 5000;

    const TONE = {
      ok: "var(--dsw-alias-state-success-primary, #2f9e44)",
      warn: "var(--dsw-alias-state-warning-primary, #e8a33d)",
      bad: "var(--dsw-alias-state-error-primary, #e5484d)",
      muted: "var(--dsw-alias-label-secondary, #8a8a8a)"
    };

    // ---------------------------------------------------------------- parsing

    function callArgs(block) {
      try {
        const call = block && "kind" in block ? block.call : block;
        if (call === null || call === undefined || typeof call.argsRaw !== "string") return {};
        const parsed = JSON.parse(call.argsRaw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    function resultValue(block) {
      try {
        const content = Array.isArray(block?.content) ? block.content : [];
        if (content.length !== 1) return undefined;
        const only = content[0];
        if (only === null || typeof only !== "object" || only.type !== "text") return undefined;
        const parsed = JSON.parse(only.text);
        return parsed !== null && typeof parsed === "object" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }

    const text = (value) => (typeof value === "string" ? value : "");

    // ------------------------------------------------------------------ cards

    function row(children) {
      return React.createElement(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "baseline", fontSize: "12.5px", lineHeight: "1.6", minWidth: "0" } },
        children
      );
    }

    function line(label, value, tone) {
      return row([
        React.createElement("span", { key: "l", style: { color: TONE.muted, flex: "0 0 auto" } }, label),
        React.createElement("span", { key: "v", style: { color: tone ?? "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, value)
      ]);
    }

    function availabilityTone(availability) {
      if (availability === "deleted") return TONE.bad;
      if (availability === "retired") return TONE.muted;
      if (availability === "idle-ready") return TONE.warn;
      if (availability === "working") return TONE.ok;
      return undefined;
    }

    function pressureChip(pressure) {
      if (pressure === null || typeof pressure !== "object") return null;
      const level = text(pressure.level);
      if (level === "" || level === "unknown") return null;
      const tone = level === "over" || level === "near_saturated" ? TONE.bad : level === "watch" ? TONE.warn : TONE.ok;
      const tokens = typeof pressure.tokens === "number" ? ` ${pressure.tokens}` : "";
      const ratio = typeof pressure.ratio === "number" ? ` · ${Math.round(pressure.ratio * 100)}%` : "";
      return React.createElement("span", { style: { color: tone, fontSize: "12px", whiteSpace: "nowrap" } }, `${level}${tokens}${ratio}`);
    }

    function overviewCard(value) {
      const members = Array.isArray(value.members) ? value.members : [];
      const capacity = value.team !== null && typeof value.team === "object" ? value.team.capacity ?? {} : {};
      const lines = [
        React.createElement("div", { key: "head", style: { fontWeight: 600, fontSize: "13px" } }, `容量 ${capacity.used ?? "?"}/${capacity.max ?? "?"}（剩 ${capacity.free ?? "?"}）`)
      ];
      const shown = members.slice(0, 8);
      for (const member of shown) {
        const availability = text(member.availability);
        lines.push(
          row([
            React.createElement("span", { key: "n", style: { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, text(member.displayName) || text(member.target) || "?"),
            React.createElement("span", { key: "a", style: { color: availabilityTone(availability) ?? TONE.muted, fontSize: "12px" } }, availability || text(member.status)),
            pressureChip(member.contextPressure)
          ])
        );
      }
      if (members.length > shown.length) lines.push(line("", `… 另有 ${members.length - shown.length} 个成员`, TONE.muted));
      for (const note of (Array.isArray(value.diagnostics) ? value.diagnostics : []).slice(0, 3)) lines.push(line("提示", text(note), TONE.warn));
      return lines;
    }

    function editCard(value) {
      const resolved = value.target !== null && typeof value.target === "object" ? value.target.resolved ?? {} : {};
      const lines = [line("操作", `${text(value.action)} → ${text(resolved.coreName) || "?"}`)];
      const handover = value.taskHandover;
      if (handover !== null && typeof handover === "object" && handover.attempted === true) {
        lines.push(line("任务交接", handover.ok === true ? "成功" : `失败：${text(handover.reason) || "unknown"}`, handover.ok === true ? TONE.ok : TONE.bad));
      }
      for (const effect of (Array.isArray(value.effects) ? value.effects : []).slice(0, 4)) lines.push(line("", text(effect)));
      for (const warning of (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 3)) lines.push(line("警告", text(warning), TONE.warn));
      return lines;
    }

    function capacityCard(value) {
      return [
        line("上限", `${value.before ?? "?"} → ${value.after ?? "?"}`, TONE.ok),
        line("占用", `已用 ${value.used ?? "?"} · 剩余 ${value.free ?? "?"}${typeof value.configured === "number" ? ` · configured ${value.configured}` : ""}`)
      ];
    }

    function messageCard(value, args) {
      const resolved = value.target !== null && typeof value.target === "object" ? value.target : {};
      const delivery = value.delivery !== null && typeof value.delivery === "object" ? value.delivery : {};
      return [
        line("投递", `${text(resolved.kind) || "?"} → ${text(resolved.coreName) || text(resolved.id) || text(args.target) || "?"}`),
        line("通道", `${text(delivery.channel) || "?"}${delivery.status === undefined || delivery.status === null ? "" : ` · ${text(delivery.status)}`}`, TONE.ok)
      ];
    }

    function addCard(value) {
      const member = value.member !== null && typeof value.member === "object" ? value.member : {};
      const lines = [line("新建", `${text(member.target) || "?"}${member.status === undefined || member.status === null ? "" : ` · ${text(member.status)}`}`, TONE.ok)];
      for (const effect of (Array.isArray(value.effects) ? value.effects : []).slice(0, 3)) lines.push(line("", text(effect)));
      return lines;
    }

    function deleteCard(value) {
      const deleted = value.deleted !== null && typeof value.deleted === "object" ? value.deleted : {};
      const lines = [line("删除", text(deleted.target) || "?", TONE.bad)];
      if (typeof deleted.seal === "string") lines.push(line("内核记录", deleted.seal));
      if (value.capacity !== null && typeof value.capacity === "object") lines.push(line("名额", `${value.capacity.before ?? "?"} → ${value.capacity.after ?? "?"}`, TONE.ok));
      for (const warning of (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 2)) lines.push(line("警告", text(warning), TONE.warn));
      return lines;
    }

    function TeamToolRow({ toolName, block }) {
      const args = callArgs(block);
      const value = resultValue(block);
      const running = block !== null && typeof block === "object" && block.phase === "preparing";
      const failed = block !== null && typeof block === "object" && block.isError === true;
      let lines;
      if (failed || value === undefined) {
        lines = [line(running ? "进行中" : "结果", running ? "等待工具返回…" : "无结构化结果（展开看原文）", running ? TONE.muted : TONE.warn)];
      } else if (toolName === "team_overview") lines = overviewCard(value);
      else if (toolName === "team_member_edit") lines = editCard(value);
      else if (toolName === "team_capacity_set") lines = capacityCard(value);
      else if (toolName === "team_message") lines = messageCard(value, args);
      else if (toolName === "team_member_add") lines = addCard(value);
      else if (toolName === "team_member_delete") lines = deleteCard(value);
      else lines = [];
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0", padding: "2px 0" } }, ...lines);
    }

    // ------------------------------------------------------------ team panel

    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    /**
     * Best-effort "which session am I looking at".
     *
     * The roster is keyed by the root session, so a panel that showed one fixed
     * team would be wrong from any other session. The app keeps the current
     * selection in a persisted store whose value shape is not part of any
     * contract, so this only *searches* for a UUID (URL first, then that store)
     * and the panel always offers a picker when more than one team is live.
     */
    function detectSessionId() {
      try {
        const url = new URL(window.location.href);
        const direct = [url.searchParams.get("session"), url.hash.replace(/^#/, ""), url.pathname.split("/").filter(Boolean).pop()];
        for (const candidate of direct) {
          if (typeof candidate === "string" && UUID.test(candidate) && candidate.length <= 64) return candidate;
        }
      } catch {
        /* no URL context */
      }
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key === null || !key.startsWith("dsh.sessions.current")) continue;
          const match = (localStorage.getItem(key) ?? "").match(UUID);
          if (match !== null) return match[0];
        }
      } catch {
        /* storage unavailable */
      }
      return undefined;
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetch(TEAM_ROUTE, { headers: { accept: "application/json" } })
            .then((response) => response.json())
            .then((value) => {
              if (!alive) return;
              setSnapshot(value);
              setError(value?.ok === true ? null : text(value?.reason) || "unavailable");
            })
            .catch((cause) => {
              if (!alive) return;
              setError(String(cause?.message ?? cause));
            });
        };
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);
      return { snapshot, error };
    }

    /** A picker so every session's team is reachable, not just the first one. */
    function TeamPicker({ teams, activeRoot, onPick }) {
      return React.createElement(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "4px", padding: "0 10px 6px" } },
        ...teams.map((team) => {
          const root = text(team.root);
          const selected = root === activeRoot;
          return React.createElement(
            "button",
            {
              key: root,
              type: "button",
              onClick: () => onPick(root),
              title: root,
              style: {
                border: "1px solid var(--dsw-alias-border-secondary, #2a2a2a)",
                background: selected ? "var(--dsw-alias-interactive-secondary-bg, #2a2a2a)" : "transparent",
                color: selected ? "inherit" : TONE.muted,
                borderRadius: "4px",
                padding: "2px 6px",
                fontSize: "11.5px",
                cursor: "pointer"
              }
            },
            `${root.slice(0, 8)} · ${team.capacity?.used ?? "?"}`
          );
        })
      );
    }

    function TeamPanel() {
      const { snapshot, error } = useSnapshot();
      // Tolerate an older host half: it returned one team at the top level
      // (`{ ok, root, members, capacity }`) instead of `{ teams: [...] }`. The
      // client bundle reloads on its own, so host and browser halves can be one
      // version apart and the panel must not go blank in between.
      const teams = Array.isArray(snapshot?.teams)
        ? snapshot.teams
        : snapshot?.ok === true && Array.isArray(snapshot?.members)
          ? [snapshot]
          : [];
      const detected = React.useMemo(() => detectSessionId(), []);
      const [picked, setPicked] = React.useState(undefined);
      const wanted = picked ?? detected;
      const active = teams.find((team) => team.root === wanted) ?? teams[0];
      const members = Array.isArray(active?.members) ? active.members : [];
      const capacity = active?.capacity ?? {};

      const heading = snapshot === null
        ? "Agent Team…"
        : active === undefined
          ? "Agent Team · 无活跃团队"
          : `Agent Team · ${capacity.used ?? "?"}/${capacity.max ?? "?"}`;
      const children = [
        React.createElement("div", { key: "h", style: { fontWeight: 600, fontSize: "13px", padding: "8px 10px 2px" } }, heading)
      ];
      if (error === null) {
        children.push(
          React.createElement(
            "div",
            { key: "s", style: { color: TONE.muted, fontSize: "12px", padding: "0 10px 6px" } },
            snapshot === null
              ? "读取中"
              : active === undefined
                ? "团队只在它的 Lead 会话存活时存在；当前进程里没有活跃团队。"
                : `根会话 ${text(active.root).slice(0, 8)} · 剩余 ${capacity.free ?? "?"} 个名额`
          )
        );
      } else {
        children.push(React.createElement("div", { key: "s", style: { color: TONE.bad, fontSize: "12px", padding: "0 10px 6px" } }, error));
      }
      if (teams.length > 1) {
        children.push(
          React.createElement(TeamPicker, {
            key: "picker",
            teams,
            activeRoot: text(active?.root),
            onPick: setPicked
          })
        );
      }
      members.forEach((member, index) => {
        const availability = text(member.availability);
        children.push(
          React.createElement(
            "div",
            {
              key: `${text(member.target)}-${index}`,
              style: { display: "flex", flexDirection: "column", gap: "1px", padding: "5px 10px", borderTop: "1px solid var(--dsw-alias-border-secondary, #2a2a2a)" }
            },
            row([
              React.createElement("span", { key: "n", style: { fontWeight: 500 } }, text(member.displayName) || "?"),
              React.createElement("span", { key: "a", style: { color: availabilityTone(availability) ?? TONE.muted, fontSize: "12px" } }, availability),
              React.createElement("span", { key: "m", style: { color: TONE.muted, fontSize: "11.5px" } }, text(member.model))
            ]),
            text(member.description) === ""
              ? null
              : React.createElement("div", { style: { color: TONE.muted, fontSize: "11.5px", lineHeight: "1.5" } }, text(member.description))
          )
        );
      });
      return React.createElement("div", { style: { display: "flex", flexDirection: "column", overflowY: "auto", height: "100%" } }, ...children);
    }

    // ------------------------------------------------------------------ apply

    return {
      name: "team-conductor-ui",
      inject: ["slots"],
      apply(ctx) {
        const diag = { toolCards: null, settingsSection: null, retries: 0 };

        const report = () => {
          try {
            void fetch("/dsh-team-conductor/client-hello", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(diag)
            }).catch(() => undefined);
          } catch {
            /* never break rendering because the probe failed */
          }
        };

        /** Run one registration stage and record what actually happened. */
        const stage = (key, run) => {
          try {
            const result = run();
            diag[key] = "ok";
            return result;
          } catch (error) {
            diag[key] = `error: ${String(error?.message ?? error)}`;
            return undefined;
          }
        };

        stage("toolCards", () =>
          ctx.slots.inject("tool.call.toolview", () =>
            TOOL_NAMES.map((toolName) => ctx.slots.register({ name: "tool.call.toolview", key: toolName }, TeamToolRow))
          )
        );

        // The roster panel lives in Settings (`settings.section`) rather than a
        // right-sidebar tab: it is where a user goes to adjust plugins, it needs
        // no navigation service, and the section slot is declared statically —
        // so there is no late-binding service to wait for.
        stage("settingsSection", () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: SECTION_ID,
                order: SECTION_ORDER,
                // `label` is a function on this slot, not a string.
                label: () => "Agent Team"
              },
              TeamPanel
            )
          )
        );

        report();
        // A couple of cheap re-reports: if a contribution is rejected for a
        // reason that resolves itself, the last report shows it.
        for (const delay of [1500, 5000]) {
          setTimeout(() => {
            diag.retries += 1;
            report();
          }, delay);
        }
      }
    };
  }
});
