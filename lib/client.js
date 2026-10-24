/**
 * dsh-team-conductor — browser half.
 *
 * Renders the conductor's six tools as compact cards in the transcript instead
 * of a raw JSON blob. The GUI picks a renderer by tool name through the
 * `tool.call.toolview` slot, so without this file every conductor call falls
 * back to the generic body view.
 *
 * Contract copied from the shipped client (`@deepseek-ai/dsh-client-ui-tool`):
 * a row receives `{ toolName, block, ... }`, where `block.content` is the
 * rendered content array returned by the host half's `output.render` (one text
 * block holding JSON), and `block.call`/`block` carries `argsRaw`.
 *
 * Every read is defensive: a shape change must degrade to a short summary, not
 * break the transcript.
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

    const TONE = {
      ok: "var(--dsw-alias-state-success-primary, #2f9e44)",
      warn: "var(--dsw-alias-state-warning-primary, #e8a33d)",
      bad: "var(--dsw-alias-state-error-primary, #e5484d)",
      muted: "var(--dsw-alias-label-secondary, #8a8a8a)"
    };

    /** The parsed args of one tool call, or {} when not available yet. */
    function callArgs(block) {
      try {
        const call = block && "kind" in block ? block.call : block;
        if (call === null || call === undefined) return {};
        if (typeof call.argsRaw !== "string") return {};
        const parsed = JSON.parse(call.argsRaw);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    /** The parsed result value, or undefined while running / on malformed output. */
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

    /** One coloured level chip for a context-pressure reading. */
    function pressureChip(pressure) {
      if (pressure === null || typeof pressure !== "object") return null;
      const level = text(pressure.level);
      if (level === "" || level === "unknown") return null;
      if (pressure.known !== true && level !== "unknown") {
        // measured tag is missing but the level survived — still show it
      }
      const tone = level === "over" ? TONE.bad : level === "near_saturated" ? TONE.bad : level === "watch" ? TONE.warn : TONE.ok;
      const tokens = typeof pressure.tokens === "number" ? `${pressure.tokens}` : "?";
      const ratio = typeof pressure.ratio === "number" ? ` · ${Math.round(pressure.ratio * 100)}%` : "";
      return React.createElement("span", { style: { color: tone, fontSize: "12px", whiteSpace: "nowrap" } }, `${level} ${tokens}${ratio}`);
    }

    function row(parts) {
      return React.createElement(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "baseline", fontSize: "12.5px", lineHeight: "1.6", minWidth: "0" } },
        parts
      );
    }

    function line(label, value, tone) {
      return row([
        React.createElement("span", { key: "l", style: { color: TONE.muted, flex: "0 0 auto" } }, label),
        React.createElement("span", { key: "v", style: { color: tone ?? "inherit", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, value)
      ]);
    }

    /** team_overview → capacity line + one line per member. */
    function overviewCard(value) {
      const members = Array.isArray(value.members) ? value.members : [];
      const capacity = value.team !== null && typeof value.team === "object" ? value.team.capacity ?? {} : {};
      const head = `容量 ${capacity.used ?? "?"}/${capacity.max ?? "?"}（剩 ${capacity.free ?? "?"}）`;
      const lines = [
        React.createElement("div", { key: "head", style: { fontWeight: 600, fontSize: "13px" } }, head)
      ];
      const shown = members.slice(0, 8);
      for (const [index, member] of shown.entries()) {
        const name = text(member.displayName) || text(member.target) || "?";
        const availability = text(member.availability);
        const tone = availability === "deleted" ? TONE.bad : availability === "retired" ? TONE.muted : availability === "idle-ready" ? TONE.warn : undefined;
        const pressure = pressureChip(member.contextPressure);
        lines.push(
          row([
            React.createElement("span", { key: "n", style: { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, name),
            React.createElement("span", { key: "a", style: { color: tone ?? TONE.muted, fontSize: "12px" } }, availability || text(member.status)),
            pressure
          ])
        );
      }
      if (members.length > shown.length) {
        lines.push(line("", `… 另有 ${members.length - shown.length} 个成员`, TONE.muted));
      }
      const notes = Array.isArray(value.diagnostics) ? value.diagnostics : [];
      for (const note of notes.slice(0, 3)) {
        lines.push(line("提示", text(note), TONE.warn));
      }
      return lines;
    }

    /** team_member_edit → "action → target" plus its effects. */
    function editCard(value) {
      const resolved = value.target !== null && typeof value.target === "object" ? value.target.resolved ?? {} : {};
      const name = text(resolved.coreName) || text(value.target?.requested) || "?";
      const lines = [line("操作", `${text(value.action)} → ${name}`)];
      const handover = value.taskHandover;
      if (handover !== null && typeof handover === "object" && handover.attempted === true) {
        lines.push(line("任务交接", handover.ok === true ? "成功" : `失败：${text(handover.reason) || "unknown"}`, handover.ok === true ? TONE.ok : TONE.bad));
      }
      for (const effect of (Array.isArray(value.effects) ? value.effects : []).slice(0, 4)) {
        lines.push(line("", text(effect)));
      }
      for (const warning of (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 3)) {
        lines.push(line("警告", text(warning), TONE.warn));
      }
      return lines;
    }

    function capacityCard(value) {
      const lines = [line("上限", `${value.before ?? "?"} → ${value.after ?? "?"}`, TONE.ok)];
      lines.push(line("占用", `已用 ${value.used ?? "?"} · 剩余 ${value.free ?? "?"}${typeof value.configured === "number" ? ` · configured ${value.configured}` : ""}`));
      return lines;
    }

    function messageCard(value, args) {
      const resolved = value.target !== null && typeof value.target === "object" ? value.target : {};
      const delivery = value.delivery !== null && typeof value.delivery === "object" ? value.delivery : {};
      const name = text(resolved.coreName) || text(resolved.id) || text(args.target) || "?";
      return [
        line("投递", `${text(resolved.kind) || "?"} → ${name}`),
        line("通道", `${text(delivery.channel) || "?"}${delivery.status === undefined || delivery.status === null ? "" : ` · ${text(delivery.status)}`}`, TONE.ok)
      ];
    }

    function addCard(value) {
      const member = value.member !== null && typeof value.member === "object" ? value.member : {};
      return [
        line("新建", `${text(member.target) || "?"}${member.status === undefined || member.status === null ? "" : ` · ${text(member.status)}`}`, TONE.ok),
        ...(Array.isArray(value.effects) ? value.effects.slice(0, 3).map((effect) => line("", text(effect))) : [])
      ];
    }

    function deleteCard(value) {
      const deleted = value.deleted !== null && typeof value.deleted === "object" ? value.deleted : {};
      const notes = [];
      notes.push(line("删除", text(deleted.target) || "?", TONE.bad));
      if (typeof deleted.seal === "string") notes.push(line("内核记录", deleted.seal));
      if (value.capacity !== null && typeof value.capacity === "object") {
        notes.push(line("名额", `${value.capacity.before ?? "?"} → ${value.capacity.after ?? "?"}`, TONE.ok));
      }
      for (const warning of (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 2)) {
        notes.push(line("警告", text(warning), TONE.warn));
      }
      return notes;
    }

    /** Render one conductor tool card. */
    function TeamToolRow({ toolName, block }) {
      const args = callArgs(block);
      const value = resultValue(block);
      const running = block !== null && typeof block === "object" && block.phase === "preparing";
      const failed = block !== null && typeof block === "object" && block.isError === true;

      let lines;
      if (failed || value === undefined) {
        lines = [line(running ? "进行中" : "结果", running ? "等待工具返回…" : "无结构化结果（展开看原文）", running ? TONE.muted : TONE.warn)];
      } else if (toolName === "team_overview") {
        lines = overviewCard(value);
      } else if (toolName === "team_member_edit") {
        lines = editCard(value);
      } else if (toolName === "team_capacity_set") {
        lines = capacityCard(value);
      } else if (toolName === "team_message") {
        lines = messageCard(value, args);
      } else if (toolName === "team_member_add") {
        lines = addCard(value);
      } else if (toolName === "team_member_delete") {
        lines = deleteCard(value);
      } else {
        lines = [];
      }

      return React.createElement(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0", padding: "2px 0" } },
        ...lines
      );
    }

    return {
      name: "team-conductor-ui",
      inject: ["slots"],
      apply(ctx) {
        // Announce the load to the host half. A client bundle is registered by
        // the host at composition time, so "the file exists" proves nothing —
        // this POST is what lets the status route (and a human) see that the
        // page really picked the client half up.
        try {
          void fetch("/dsh-team-conductor/client-hello", { method: "POST" }).catch(() => undefined);
        } catch {
          /* never break rendering because the probe failed */
        }
        // `slots.inject` declares the contribution before registering, so the
        // slot owner can decide whether the slot is active at all.
        ctx.slots.inject("tool.call.toolview", () =>
          TOOL_NAMES.map((toolName) => ctx.slots.register({ name: "tool.call.toolview", key: toolName }, TeamToolRow))
        );
      }
    };
  }
});
