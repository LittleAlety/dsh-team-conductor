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
    const ACTION_ROUTE = "/dsh-team-conductor/action";
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
     * The roster is keyed by the root session, so a panel pinned to one team
     * would be wrong from any other session. The app keeps the current selection
     * in a persisted store whose value shape is not a contract, so this only
     * *searches* for a UUID (URL first, then that store); the panel always offers
     * a picker when more than one team is live.
     */
    function detectSessionId() {
      try {
        const url = new URL(window.location.href);
        const direct = [url.searchParams.get("session"), url.hash.replace(/^#/, ""), url.pathname.split("/").filter(Boolean).pop()];
        for (const candidate of direct) {
          if (typeof candidate === "string" && candidate.length <= 64 && UUID.test(candidate)) return candidate;
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

    /** POST one action to the host, which runs the real tool implementation. */
    async function act(tool, args, session) {
      const response = await fetch(ACTION_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args, session })
      });
      if (response.status === 404 || response.status === 405) {
        // The host half registers this endpoint at apply time, so a freshly
        // reloaded client can outrun it. Say so instead of a fetch error.
        return { ok: false, reason: "宿主还没加载操作端点：需要重启一次 Harness 才能启用这些按钮" };
      }
      return response.json();
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
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
      }, [nonce]);
      return { snapshot, error, refresh: () => setNonce((value) => value + 1) };
    }

    // ------------------------------------------------------------- primitives

    const cardStyle = {
      border: "1px solid var(--dsw-alias-border-secondary, #2a2a2a)",
      borderRadius: "8px",
      padding: "10px 12px",
      margin: "0 0 10px",
      background: "var(--dsw-alias-bg-secondary, transparent)"
    };

    function Card({ title, hint, children }) {
      return React.createElement(
        "section",
        { style: cardStyle },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" } },
          React.createElement("h3", { style: { margin: 0, fontSize: "13.5px", fontWeight: 600 } }, title),
          hint === undefined ? null : React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } }, hint)
        ),
        ...children
      );
    }

    function Btn({ label, onClick, tone, disabled, title }) {
      const colour = tone === "danger" ? TONE.bad : tone === "primary" ? TONE.ok : "inherit";
      return React.createElement(
        "button",
        {
          type: "button",
          title: title ?? label,
          disabled: disabled === true,
          onClick,
          style: {
            border: `1px solid ${tone === "danger" ? "var(--dsw-alias-state-error-primary, #e5484d)" : "var(--dsw-alias-border-secondary, #2a2a2a)"}`,
            background: "transparent",
            color: colour,
            borderRadius: "4px",
            padding: "2px 8px",
            fontSize: "11.5px",
            cursor: disabled === true ? "default" : "pointer",
            opacity: disabled === true ? 0.5 : 1
          }
        },
        label
      );
    }

    function Field({ value, onInput, placeholder, width }) {
      return React.createElement("input", {
        value,
        placeholder: placeholder ?? "",
        onChange: (event) => onInput(event.target.value),
        style: {
          width: width ?? "120px",
          background: "transparent",
          color: "inherit",
          border: "1px solid var(--dsw-alias-border-secondary, #2a2a2a)",
          borderRadius: "4px",
          padding: "2px 6px",
          fontSize: "11.5px"
        }
      });
    }

    function Badge({ text: value, tone }) {
      return React.createElement(
        "span",
        {
          style: {
            color: tone ?? TONE.muted,
            border: `1px solid ${tone ?? "var(--dsw-alias-border-secondary, #2a2a2a)"}`,
            borderRadius: "999px",
            padding: "0 6px",
            fontSize: "11px",
            whiteSpace: "nowrap"
          }
        },
        value
      );
    }

    // ---------------------------------------------------------------- members

    function MemberRow({ member, sessionId, onDone, busy, setBusy }) {
      const target = text(member.target);
      const availability = text(member.availability);
      const [alias, setAlias] = React.useState(text(member.alias));
      const [description, setDescription] = React.useState(text(member.description));
      const editable = text(member.role) === "teammate";
      const gone = member.deleted === true;

      const run = async (label, tool, args) => {
        if (busy !== null) return;
        setBusy(`${label}…`);
        try {
          const value = await act(tool, args, sessionId);
          onDone(value);
        } catch (cause) {
          onDone({ ok: false, reason: String(cause?.message ?? cause) });
        } finally {
          setBusy(null);
        }
      };

      const dirtyAlias = editable && alias !== text(member.alias);
      const dirtyDescription = editable && description !== text(member.description);

      return React.createElement(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            padding: "8px 0",
            borderTop: "1px solid var(--dsw-alias-border-secondary, #2a2a2a)",
            opacity: gone ? 0.55 : 1
          }
        },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          React.createElement("strong", { style: { fontSize: "12.5px" } }, text(member.displayName) || target),
          React.createElement(Badge, { text: availability, tone: availabilityTone(availability) }),
          React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } }, text(member.model) || text(member.role)),
          React.createElement("span", { style: { color: TONE.muted, fontSize: "11px" } }, target)
        ),
        editable
          ? React.createElement(
            "div",
            { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
            React.createElement(Field, { value: alias, onInput: setAlias, placeholder: "别名" }),
            dirtyAlias
              ? React.createElement(Btn, {
                label: "存别名",
                tone: "primary",
                onClick: () => run("别名", "team_member_edit", { target, action: "alias", value: alias })
              })
              : null,
            React.createElement(Field, { value: description, onInput: setDescription, placeholder: "职责", width: "240px" }),
            dirtyDescription
              ? React.createElement(Btn, {
                label: "存职责",
                tone: "primary",
                onClick: () => run("职责", "team_member_edit", { target, action: "describe", value: description })
              })
              : null
          )
          : null,
        editable
          ? React.createElement(
            "div",
            { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
            gone
              ? null
              : React.createElement(Btn, {
                label: "压缩",
                title: "压缩该成员的上下文（需要已加载）",
                disabled: busy !== null,
                onClick: () => run("压缩", "team_member_edit", { target, action: "compact" })
              }),
            gone
              ? null
              : React.createElement(Btn, {
                label: member.retired === true ? "恢复" : "退休",
                disabled: busy !== null,
                onClick: () => run("退休", "team_member_edit", { target, action: member.retired === true ? "restore" : "retire" })
              }),
            gone
              ? null
              : React.createElement(Btn, {
                label: "删除",
                tone: "danger",
                disabled: busy !== null,
                title: "不可逆：立墓碑、拦截消息、补一个名额",
                onClick: () => {
                  if (window.confirm(`删除成员 ${text(member.displayName) || target}？此操作不可逆。`)) {
                    void run("删除", "team_member_delete", { target });
                  }
                }
              })
          )
          : null
      );
    }

    // ---------------------------------------------------------------- console

    function TeamConsole() {
      const { snapshot, error, refresh } = useSnapshot();
      // Tolerate an older host half: it returned one team at the top level. The
      // client bundle reloads on its own while the host waits for a restart, so
      // the two halves can be one version apart and must not go blank.
      const teams = Array.isArray(snapshot?.teams)
        ? snapshot.teams
        : snapshot?.ok === true && Array.isArray(snapshot?.members)
          ? [snapshot]
          : [];
      const detected = React.useMemo(() => detectSessionId(), []);
      const [picked, setPicked] = React.useState(undefined);
      const wanted = picked ?? detected;
      const active = teams.find((team) => team.root === wanted) ?? teams[0];
      const rootId = text(active?.root);
      const members = Array.isArray(active?.members) ? active.members : [];
      const capacity = active?.capacity ?? {};

      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [ceiling, setCeiling] = React.useState("");
      const [newName, setNewName] = React.useState("");
      const [newBrief, setNewBrief] = React.useState("");

      React.useEffect(() => {
        setCeiling(capacity.max === undefined ? "" : String(capacity.max));
      }, [capacity.max]);

      const onDone = (value) => {
        if (value === null || typeof value !== "object") {
          setNotice({ tone: TONE.muted, text: "已完成" });
        } else if (value.ok === false) {
          setNotice({ tone: TONE.bad, text: `失败：${text(value.reason) || "unknown"}` });
        } else {
          const bits = [];
          for (const effect of (Array.isArray(value.effects) ? value.effects : []).slice(0, 3)) bits.push(text(effect));
          if (value.taskHandover !== undefined && value.taskHandover !== null && value.taskHandover.ok === false) {
            bits.push(`任务交接失败：${text(value.taskHandover.reason)}`);
          }
          for (const warning of (Array.isArray(value.warnings) ? value.warnings : []).slice(0, 2)) bits.push(text(warning));
          setNotice({ tone: bits.length > 0 && (value.warnings ?? []).length > 0 ? TONE.warn : TONE.ok, text: bits.join(" · ") || "已完成" });
        }
        refresh();
      };

      const runCapacity = async () => {
        const wanted = Number.parseInt(ceiling, 10);
        if (!Number.isFinite(wanted)) {
          setNotice({ tone: TONE.bad, text: "上限必须是数字" });
          return;
        }
        setBusy("上限…");
        try {
          onDone(await act("team_capacity_set", { max_members: wanted }, rootId));
        } catch (cause) {
          onDone({ ok: false, reason: String(cause?.message ?? cause) });
        } finally {
          setBusy(null);
        }
      };

      const runAdd = async () => {
        if (newName.trim() === "") {
          setNotice({ tone: TONE.bad, text: "新成员需要名字" });
          return;
        }
        setBusy("新建…");
        try {
          onDone(await act("team_member_add", { name: newName.trim(), brief: newBrief.trim() === "" ? undefined : newBrief.trim() }, rootId));
          setNewName("");
          setNewBrief("");
        } catch (cause) {
          onDone({ ok: false, reason: String(cause?.message ?? cause) });
        } finally {
          setBusy(null);
        }
      };

      const header = React.createElement(
        "header",
        { style: { display: "flex", alignItems: "baseline", gap: "10px", margin: "0 0 10px" } },
        React.createElement("h2", { style: { margin: 0, fontSize: "15px", fontWeight: 600 } }, "Agent Team"),
        React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } }, snapshot === null ? "读取中…" : `v${text(snapshot.version)}`),
        React.createElement(Btn, { label: "刷新", onClick: refresh, disabled: busy !== null }),
        busy === null ? null : React.createElement("span", { style: { color: TONE.warn, fontSize: "11.5px" } }, busy)
      );

      const children = [header];

      if (error !== null) {
        children.push(React.createElement("div", { style: { color: TONE.bad, fontSize: "12px", marginBottom: "8px" } }, error));
      }
      if (notice !== null) {
        children.push(React.createElement("div", { style: { color: notice.tone, fontSize: "12px", marginBottom: "8px" } }, notice.text));
      }

      if (teams.length > 1) {
        children.push(
          React.createElement(
            Card,
            { key: "teams", title: "活跃团队", hint: `${teams.length} 支（团队按 root 会话隔离）` },
            [
              React.createElement(
                "div",
                { key: "list", style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                ...teams.map((team) => {
                  const root = text(team.root);
                  const selected = root === rootId;
                  return React.createElement(Btn, {
                    key: root,
                    label: `${root.slice(0, 8)} · ${team.capacity?.used ?? "?"}/${team.capacity?.max ?? "?"}`,
                    tone: selected ? "primary" : undefined,
                    onClick: () => setPicked(root)
                  });
                })
              )
            ]
          )
        );
      }

      if (snapshot !== null && teams.length === 0) {
        children.push(
          React.createElement(
            Card,
            { key: "empty", title: "无活跃团队" },
            [
              React.createElement(
                "div",
                { key: "body", style: { color: TONE.muted, fontSize: "12px", lineHeight: "1.6" } },
                "团队只在它的 Lead 会话存活时存在。打开一个有团队的会话，或让 Lead 先创建一个 teammate。"
              )
            ]
          )
        );
      }

      if (active !== undefined) {
        children.push(
          React.createElement(
            Card,
            { key: "capacity", title: "容量", hint: `根会话 ${rootId.slice(0, 8)} · 部署上限 ${capacity.configured ?? "?"}` },
            [
              React.createElement(
                "div",
                { key: "row", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                React.createElement("span", { style: { fontSize: "13px", fontWeight: 600 } }, `${capacity.used ?? "?"} / ${capacity.max ?? "?"}`),
                React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } }, `剩余 ${capacity.free ?? "?"}`),
                React.createElement(Field, { value: ceiling, onInput: setCeiling, placeholder: "上限", width: "64px" }),
                React.createElement(Btn, { label: "应用", tone: "primary", disabled: busy !== null, onClick: runCapacity })
              )
            ]
          )
        );

        children.push(
          React.createElement(
            Card,
            { key: "members", title: "成员", hint: `${members.length} 个 · 每 5 秒刷新` },
            members.length === 0
              ? [React.createElement("div", { key: "none", style: { color: TONE.muted, fontSize: "12px" } }, "还没有成员")]
              : members.map((member) =>
                React.createElement(MemberRow, {
                  key: text(member.target),
                  member,
                  sessionId: rootId,
                  onDone,
                  busy,
                  setBusy
                })
              )
          )
        );

        children.push(
          React.createElement(
            Card,
            { key: "add", title: "新建成员", hint: "满员时自动提额" },
            [
              React.createElement(
                "div",
                { key: "row", style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
                React.createElement(Field, { value: newName, onInput: setNewName, placeholder: "名字（lower-kebab-case）" }),
                React.createElement(Field, { value: newBrief, onInput: setNewBrief, placeholder: "简报（可留空）", width: "280px" }),
                React.createElement(Btn, { label: "创建", tone: "primary", disabled: busy !== null, onClick: runAdd })
              )
            ]
          )
        );
      }

      return React.createElement("div", { style: { padding: "12px 14px", overflowY: "auto", height: "100%", boxSizing: "border-box" } }, ...children);
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
              TeamConsole
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
