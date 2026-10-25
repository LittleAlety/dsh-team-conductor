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

    /**
     * Visual scale for this panel.
     *
     * Every value prefers the harness' own design token and falls back to a
     * hand-tuned number, so the panel inherits whatever the app theme ships while
     * still looking right on a build that does not define those tokens. Spacing
     * follows a 4/6/8/12/16 rhythm and borders stay low-contrast: a hard 1px
     * #2a2a2a line reads as a heavy box on light themes and cramped on dark ones.
     */
    const UI = {
      radiusPanel: "var(--dsw-radius-panel, 14px)",
      radiusCard: "var(--dsw-radius-lg, 12px)",
      radiusControl: "var(--dsw-radius-md, 8px)",
      border: "1px solid var(--dsw-alias-border-secondary, rgba(140, 140, 140, 0.24))",
      borderSoft: "1px solid var(--dsw-alias-border-secondary, rgba(140, 140, 140, 0.16))",
      surface: "var(--dsw-alias-bg-primary, #181818)",
      surfaceSoft: "var(--dsw-alias-bg-secondary, rgba(140, 140, 140, 0.055))",
      shadow: "0 18px 44px rgba(0, 0, 0, 0.26), 0 2px 8px rgba(0, 0, 0, 0.14)",
      gap: "12px"
    };

    const STYLE_ID = "dsh-team-conductor-ui-style";

    /** Interaction states inline styles cannot express; injected once. */
    function ensureStyles() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        ".dtc-btn{transition:background-color .12s ease,color .12s ease,border-color .12s ease}",
        ".dtc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,rgba(140,140,140,.12))}",
        ".dtc-btn:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary,#2f9e44);outline-offset:1px}",
        ".dtc-row{transition:background-color .12s ease}",
        ".dtc-row:hover{background:var(--dsw-alias-bg-secondary,rgba(140,140,140,.07))}",
        ".dtc-scroll{scrollbar-width:thin;overscroll-behavior:contain}",
        ".dtc-scroll::-webkit-scrollbar{width:9px}",
        ".dtc-scroll::-webkit-scrollbar-thumb{background:rgba(140,140,140,.32);border-radius:9px}",
        ".dtc-scroll::-webkit-scrollbar-track{background:transparent}",
        ".dtc-field:focus{outline:none;border-color:var(--dsw-alias-state-success-primary,#2f9e44)}"
      ].join("");
      document.head.appendChild(style);
    }

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
      if (availability === "error") return TONE.bad;
      if (availability === "blocked") return TONE.warn;
      if (availability === "retired") return TONE.muted;
      if (availability === "awaiting-review") return TONE.warn;
      if (availability === "idle-ready") return TONE.ok;
      if (availability === "working") return TONE.ok;
      return undefined;
    }

    /**
     * Readable label for the availability state.
     *
     * "idle-ready" alone used to cover three different situations; a member whose
     * last turn failed must not look free.
     */
    function availabilityLabel(availability) {
      if (availability === "error") return "上一轮失败";
      if (availability === "blocked") return "被拦下";
      if (availability === "awaiting-review") return "待审议";
      if (availability === "working") return "运行中";
      if (availability === "idle-ready") return "空闲可用";
      if (availability === "retired") return "已退休";
      if (availability === "deleted") return "已删除";
      if (availability === "lead") return "lead";
      return availability === "" ? "状态未知" : availability;
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

    function useSnapshot(session) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [nonce, setNonce] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetch(session === undefined ? TEAM_ROUTE : `${TEAM_ROUTE}?session=${encodeURIComponent(session)}`, { headers: { accept: "application/json" } })
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
      }, [nonce, session]);
      return { snapshot, error, refresh: () => setNonce((value) => value + 1) };
    }

    // ------------------------------------------------------------- primitives

    const cardStyle = {
      border: UI.borderSoft,
      borderRadius: UI.radiusCard,
      padding: "14px 16px",
      margin: `0 0 ${UI.gap}`,
      background: UI.surfaceSoft,
      boxSizing: "border-box"
    };

    function Card({ title, hint, children }) {
      return React.createElement(
        "section",
        { style: cardStyle },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "10px", flexWrap: "wrap" } },
          React.createElement("h3", { style: { margin: 0, fontSize: "14px", fontWeight: 600, letterSpacing: "0.01em" } }, title),
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
          className: "dtc-btn",
          title: title ?? label,
          disabled: disabled === true,
          onClick,
          style: {
            border: tone === "danger" ? `1px solid ${TONE.bad}` : UI.borderSoft,
            background: "transparent",
            minHeight: "28px",
            padding: "4px 11px",
            borderRadius: UI.radiusControl,
            cursor: disabled === true ? "not-allowed" : "pointer",
            opacity: disabled === true ? 0.55 : 1,
            color: colour,
            fontSize: "12px",
            display: "inline-flex",
            alignItems: "center",
            gap: "4px"
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
        className: "dtc-field",
        style: {
          width: width ?? "120px",
          background: "transparent",
          color: "inherit",
          border: UI.borderSoft,
          borderRadius: UI.radiusControl,
          padding: "4px 9px",
          minHeight: "28px",
          boxSizing: "border-box",
          fontSize: "12px"
        }
      });
    }

    function Badge({ text: value, tone }) {
      return React.createElement(
        "span",
        {
          style: {
            color: tone ?? TONE.muted,
            border: `1px solid ${tone ?? "rgba(140, 140, 140, 0.22)"}`,
            borderRadius: "999px",
            padding: "1px 8px",
            lineHeight: "16px",
            fontSize: "11px",
            whiteSpace: "nowrap"
          }
        },
        value
      );
    }

    // ---------------------------------------------------------------- members

    /**
     * Open a member's own conversation, exactly like the kernel panel did.
     *
     * `uiWorkspace.openSession({ parentSessionId, childSessionId, mode:
     * "continuable" })` is the same navigation the shipped Agent Teams UI uses;
     * a conductor member is an ordinary continuable subagent session, so it
     * reads like any other conversation.
     */
    function openMemberSession(parentSessionId, childSessionId, engine) {
      try {
        const clientCtx = window.__dshTeamConductorCtx;
        const uiWorkspace = clientCtx?.get?.("uiWorkspace");
        if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.openSession !== "function") return false;
        if (typeof childSessionId !== "string" || childSessionId === "") return false;
        if (childSessionId === parentSessionId || engine === "session") {
          uiWorkspace.openSession(childSessionId);
          return true;
        }
        uiWorkspace.openSession({ parentSessionId, childSessionId, mode: "continuable" });
        return true;
      } catch {
        return false;
      }
    }

    function MemberRow({ member, sessionId, engine, onDone, busy, setBusy }) {
      const target = text(member.target);
      const availability = text(member.availability);
      const [alias, setAlias] = React.useState(text(member.alias));
      const [description, setDescription] = React.useState(text(member.description));
      const [model, setModel] = React.useState(text(member.model));
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
      const dirtyModel = editable && model !== text(member.model) && model.trim() !== "";

      return React.createElement(
        "div",
        {
          className: "dtc-row",
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "7px",
            padding: "11px 2px",
            borderTop: UI.borderSoft,
            opacity: gone ? 0.55 : 1
          }
        },
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          React.createElement("strong", { style: { fontSize: "12.5px" } }, text(member.role) === "lead" ? "Lead（本会话）" : text(member.displayName) || target),
          // The Lead pseudo-row's availability is literally "lead", so rendering
          // the badge too would repeat the same word twice on one line.
          text(member.role) === "lead"
            ? null
            : React.createElement(Badge, { text: availabilityLabel(availability), tone: availabilityTone(availability) }),
          React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } }, text(member.model) || text(member.role)),
          availability === "error" && member.lastTurn
            ? React.createElement("span", {
              style: { color: TONE.bad, fontSize: "11px", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              title: `${member.lastTurn.code ?? ""} ${member.lastTurn.error ?? ""}`.trim()
            }, `失败：${member.lastTurn.error ?? member.lastTurn.code ?? "未知"}`)
            : null,
          text(member.role) === "lead"
            ? null
            : React.createElement("span", { style: { color: TONE.muted, fontSize: "11px" } }, target),
          typeof member.id === "string" && member.id !== ""
            ? React.createElement(Btn, {
              label: "打开会话",
              title: "像普通对话一样打开这个成员的子会话",
              onClick: () => {
                if (!openMemberSession(sessionId, member.id, engine)) {
                  onDone({ ok: false, reason: "无法打开会话：当前界面没有可用的 uiWorkspace 服务" });
                }
              }
            })
            : null
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
              : null,
            engine === "session" ? React.createElement(Field, { value: model, onInput: setModel, placeholder: "provider/model", width: "170px" }) : null,
            engine === "session" && dirtyModel ? React.createElement(Btn, { label: "切模型", tone: "primary", disabled: busy !== null, onClick: () => run("模型", "team_member_edit", { target, action: "model", value: model.trim() }) }) : null,
            engine === "session" ? React.createElement("span", { style: { color: TONE.muted, fontSize: "11px" } }, "切换也会更新全局默认模型") : null
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
                // The consequence differs per engine, and the old text described the
                // kernel one ("补一个名额") even on session members, where no slot is
                // involved and the conversation survives.
                title: engine === "kernel"
                  ? "不可逆：立墓碑、拦截消息、补一个名额（内核 roster 行无法移除）"
                  : "解除团队关联并归档记录；会话与历史保留，名字可复用",
                onClick: () => {
                  const question = engine === "kernel"
                    ? `删除成员 ${text(member.displayName) || target}？此操作不可逆。`
                    : `把 ${text(member.displayName) || target} 移出团队？会话与历史会保留，名字可复用。`;
                  if (window.confirm(question)) {
                    void run("删除", "team_member_delete", { target });
                  }
                }
              })
          )
          : null
      );
    }

    // ---------------------------------------------------------------- console

    function TeamConsole({ fixedSession }) {
      const { snapshot, error, refresh } = useSnapshot(fixedSession);
      // Hover/focus/scrollbar states live in a stylesheet, injected once on mount.
      React.useEffect(() => {
        ensureStyles();
      }, []);
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
      const wanted = fixedSession ?? picked ?? detected;
      // Never silently fall back to "the first team": with more than one Team
      // live that would show another session's roster under this session's title.
      // The host resolves a member's conversation up to its Team root and reports
      // where it came from, so match against that resolved root instead of the raw
      // session id (which is the child id inside a member conversation).
      const resolvedFromChild = typeof snapshot?.resolvedFrom === "string" && snapshot.resolvedFrom.length > 0;
      const serverScope = text(snapshot?.sessionId);
      const active = wanted === undefined
        ? (teams.length === 1 ? teams[0] : undefined)
        : teams.find((team) => team.root === wanted)
          ?? (resolvedFromChild && serverScope !== undefined ? teams.find((team) => team.root === serverScope) ?? teams[0] : undefined);
      const needsPick = active === undefined && teams.length > 1;
      const scopedMissing = fixedSession !== undefined && active === undefined;
      const rootId = text(active?.root);
      const members = Array.isArray(active?.members) ? active.members : [];
      const capacity = active?.capacity ?? {};

      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [ceiling, setCeiling] = React.useState("");
      const [newName, setNewName] = React.useState("");
      const [newBrief, setNewBrief] = React.useState("");
      const [newMemberModel, setNewMemberModel] = React.useState("");
      const [teamModel, setTeamModel] = React.useState("");
      const [newTask, setNewTask] = React.useState("");
      const [newTaskDetails, setNewTaskDetails] = React.useState("");
      const [newTaskAcceptance, setNewTaskAcceptance] = React.useState("");
      const [taskOwners, setTaskOwners] = React.useState({});

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
          onDone(await act("team_member_add", { name: newName.trim(), brief: newBrief.trim() === "" ? undefined : newBrief.trim(), model: newMemberModel.trim() || undefined }, rootId));
          setNewName("");
          setNewBrief("");
          setNewMemberModel("");
        } catch (cause) {
          onDone({ ok: false, reason: String(cause?.message ?? cause) });
        } finally {
          setBusy(null);
        }
      };

      const runTask = async (tool, args) => {
        if (busy !== null) return;
        setBusy("任务…");
        try { onDone(await act(tool, args, rootId)); }
        catch (cause) { onDone({ ok: false, reason: String(cause?.message ?? cause) }); }
        finally { setBusy(null); }
      };

      const header = React.createElement(
        "header",
        { style: { display: "flex", alignItems: "baseline", gap: "10px", margin: "0 0 10px" } },
        React.createElement("h2", { style: { margin: 0, fontSize: "15px", fontWeight: 600 } }, "Agent Team"),
        React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } }, snapshot === null ? "读取中…" : `v${text(snapshot.version)}`),
        // Which layer owns delegation, so "1/?" is not mysterious: under the
        // conductor engine the ceiling lives in the subagent pool.
        React.createElement(
          "span",
          { style: { color: TONE.muted, fontSize: "11.5px" } },
          snapshot === null ? "" : `引擎 ${text(active?.capacity?.engine) || "?"}`
        ),
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

      if (teams.length > 1 && fixedSession === undefined) {
        children.push(
          React.createElement(
            Card,
            {
              key: "teams",
              title: "活跃团队",
              hint: needsPick
                ? "未定位到当前会话，请手动选择"
                : `${teams.length} 支（团队按 root 会话隔离）`
            },
            [
              needsPick
                ? React.createElement(
                  "div",
                  { key: "hint", style: { color: TONE.warn, fontSize: "11.5px", marginBottom: "6px", lineHeight: "1.6" } },
                  "看不到「当前会话」是正常的——设置页没有会话上下文，页面 URL 与本地存储里也找不到会话 id。下面选一支团队查看，或直接点页头的「Agent Team」按钮（那个按钮一定绑定当前会话）。"
                )
                : null,
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
      const resolvedHint = resolvedFromChild && active !== undefined
        ? `这是成员会话，显示其所属 Lead 的团队${serverScope !== undefined ? `（${serverScope.slice(0, 8)}）` : ""}`
        : null;

      if (scopedMissing) {
        children.push(
          React.createElement(
            Card,
            { key: "scoped-missing", title: "该会话没有活跃团队" },
            [
              React.createElement(
                "div",
                { key: "body", style: { color: TONE.muted, fontSize: "12px", lineHeight: "1.6" } },
                "团队只在它的 Lead 会话存活时存在。这个会话目前没有队伍，用 team_member_add 建一个即可。"
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

      if (resolvedHint !== null) {
        children.push(
          React.createElement(
            "div",
            { key: "resolved-hint", style: { color: TONE.muted, fontSize: "11px", lineHeight: "1.6", marginBottom: "2px" } },
            resolvedHint
          )
        );
      }

      if (active !== undefined) {
        children.push(
          React.createElement(
            Card,
            { key: "capacity", title: "容量", hint: capacity.engine === "kernel" ? `根会话 ${rootId.slice(0, 8)} · 部署上限 ${capacity.configured ?? "?"}` : "独立会话无团队名额上限" },
            [
              React.createElement(
                "div",
                { key: "team-model", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "10px" } },
                React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } },
                  active?.syncMemberModels === false ? "逐成员模型" : "全队模型（同步）"),
                React.createElement(Field, { value: teamModel, onInput: setTeamModel, placeholder: "provider/model", width: "210px" }),
                React.createElement(Btn, {
                  label: active?.syncMemberModels === false ? "换这个成员" : "全队切换",
                  tone: "primary",
                  disabled: busy !== null || teamModel.trim() === "",
                  onClick: () => runTask("team_member_edit", {
                    target: active?.syncMemberModels === false ? (members.find((member) => member.role === "teammate") ?? {}).target : "lead",
                    action: "model",
                    value: teamModel.trim()
                  })
                })
              ),
              React.createElement(
                "div",
                { key: "row", style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                React.createElement("span", { style: { fontSize: "13px", fontWeight: 600 } }, capacity.max == null ? `${capacity.used ?? "?"} 成员` : `${capacity.used ?? "?"} / ${capacity.max}`),
                capacity.engine === "kernel" ? React.createElement("span", { style: { color: TONE.muted, fontSize: "11.5px" } }, `剩余 ${capacity.free ?? "?"}`) : null,
                capacity.engine === "kernel" ? React.createElement(Field, { value: ceiling, onInput: setCeiling, placeholder: "上限", width: "64px" }) : null,
                capacity.engine === "kernel" ? React.createElement(Btn, { label: "应用", tone: "primary", disabled: busy !== null, onClick: runCapacity }) : null
              ),
              (capacity.deleted ?? 0) + (capacity.retired ?? 0) === 0
                ? null
                : React.createElement(
                  "div",
                  { key: "tombstones", style: { color: TONE.warn, fontSize: "11.5px", marginTop: "6px", lineHeight: "1.6" } },
                  capacity.engine === "kernel"
                    ? `其中 ${capacity.deleted ?? 0} 个已删除、${capacity.retired ?? 0} 个已退休：内核 roster 只增不删，这些行永久占名额。可用 ${capacity.serving ?? "?"} 个。`
                    : `已退休 ${capacity.retired ?? 0} 个成员；可恢复继续使用。`
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
                  engine: capacity.engine,
                  onDone,
                  busy,
                  setBusy
                })
              )
          )
        );

        // Shared task board: what work exists, who owns it, what is ready.
        const board = active?.board ?? {};
        const boardTasks = Array.isArray(board.tasks) ? board.tasks : [];
        {
          children.push(
            React.createElement(
              Card,
              {
                key: "tasks",
                title: "任务板",
                hint: `${board.active ?? 0} 未完成 / ${board.total ?? boardTasks.length} 总数`
              },
              [React.createElement("div", { key: "new", style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "12px" } },
                React.createElement(Field, { value: newTask, onInput: setNewTask, placeholder: "新任务标题", width: "220px" }),
                React.createElement(Field, { value: newTaskDetails, onInput: setNewTaskDetails, placeholder: "任务详情（派给谁都能看懂）", width: "260px" }),
                React.createElement(Field, { value: newTaskAcceptance, onInput: setNewTaskAcceptance, placeholder: "完成标准", width: "200px" }),
                React.createElement(Btn, {
                  label: "添加",
                  tone: "primary",
                  disabled: busy !== null || newTask.trim() === "",
                  onClick: () => {
                    void runTask("team_task_add", {
                      title: newTask.trim(),
                      ...(newTaskDetails.trim() === "" ? {} : { details: newTaskDetails.trim() }),
                      ...(newTaskAcceptance.trim() === "" ? {} : { acceptance: newTaskAcceptance.trim() })
                    });
                    setNewTask("");
                    setNewTaskDetails("");
                    setNewTaskAcceptance("");
                  }
                })
              ), ...boardTasks.slice(0, 10).map((task) => {
                const state = text(task.status);
                const tone = state === "done" ? TONE.ok : state === "review" ? TONE.ok : state === "in_progress" ? TONE.warn : TONE.muted;
                const stateLabel = state === "done" ? "完成" : state === "review" ? "待审议" : state === "in_progress" ? "进行中" : "待领";
                const owner = text(task.owner);
                const blocked = Array.isArray(task.blockedBy) && task.blockedBy.length > 0;
                const actionable = !blocked && (state === "pending" || state === "in_progress" || state === "review");
                return React.createElement(
                  "div",
                  {
                    key: text(task.id),
                    className: "dtc-row",
                    // Two lines instead of one crowded one: at 460px a select plus a
                    // button on the title line squeezed the title to a few glyphs.
                    style: {
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      padding: "11px 2px",
                      borderTop: UI.borderSoft,
                      fontSize: "12.5px"
                    }
                  },
                  React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", minWidth: "0" } },
                    React.createElement("span", { style: { color: TONE.muted, fontSize: "11px", minWidth: "20px" } }, text(task.id)),
                    React.createElement(Badge, { text: stateLabel, tone }),
                    React.createElement("span", { style: { flex: "1 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, text(task.title)),
                    Array.isArray(task.overlaps) && task.overlaps.length > 0
                      ? React.createElement("span", { style: { color: TONE.bad }, title: "写作用域重叠" }, "⚠")
                      : null
                  ),
                  // Who holds it, how it got there, and when — the board used to say
                  // "owner: alpha" and leave the reader guessing.
                  React.createElement(
                    "div",
                    { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", color: TONE.muted, fontSize: "11.5px" } },
                    owner === ""
                      ? React.createElement("span", null, "未认领")
                      : React.createElement("span", null, `认领人：${text(task.ownerLabel) || owner}${text(task.ownerLabel) && text(task.ownerLabel) !== owner ? `（${owner}）` : ""}`),
                    owner === "" || text(task.claimKind) === ""
                      ? null
                      : React.createElement(Badge, {
                        text: text(task.claimKind) === "auto" ? "自动派发" : text(task.claimKind) === "assign" ? "Lead 指派" : "自己认领",
                        tone: text(task.claimKind) === "auto" ? TONE.ok : TONE.muted
                      }),
                    text(task.claimedAt) === "" ? null : React.createElement("span", null, `· ${String(task.claimedAt).slice(11, 16)}`),
                    state === "done" && text(task.completedBy) !== ""
                      ? React.createElement("span", null, `完成于 ${String(task.completedAt ?? "").slice(11, 16)}（${task.completedBy}）`)
                      : null,
                    Array.isArray(task.files) && task.files.length > 0
                      ? React.createElement("span", { style: { opacity: 0.85 } }, `· 触及 ${task.files.join(", ")}`)
                      : null
                  ),
                  text(task.details) === ""
                    ? null
                    : React.createElement("div", {
                      style: {
                        color: "inherit",
                        fontSize: "12px",
                        lineHeight: "1.55",
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        whiteSpace: "pre-wrap",
                        opacity: 0.9
                      }
                    }, text(task.details)),
                  text(task.acceptance) === ""
                    ? null
                    : React.createElement("div", { style: { color: TONE.muted, fontSize: "11.5px", lineHeight: "1.5" } }, `完成标准：${text(task.acceptance)}`),
                  text(task.report) === ""
                    ? null
                    : React.createElement("div", { style: { color: TONE.ok, fontSize: "11.5px", lineHeight: "1.5" } }, `提交报告：${text(task.report)}`),
                  state === "review" && text(task.reviewRequestedAt) !== ""
                    ? React.createElement("div", { style: { color: TONE.muted, fontSize: "11px" } }, `等待 Lead 审议 · ${String(task.reviewRequestedAt).slice(11, 16)}`)
                    : null,
                  blocked
                    ? React.createElement("div", { style: { color: TONE.warn, fontSize: "11.5px" } }, `阻塞于 ${task.blockedBy.join(", ")}`)
                    : null,
                  actionable
                    ? React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                      state === "pending" ? React.createElement("select", {
                        value: taskOwners[task.id] ?? "",
                        onChange: (event) => setTaskOwners((current) => ({ ...current, [task.id]: event.target.value })),
                        title: "选择任务负责人",
                        className: "dtc-field",
                        style: {
                          flex: "1 1 140px",
                          minWidth: "120px",
                          maxWidth: "220px",
                          background: "transparent",
                          color: "inherit",
                          border: UI.borderSoft,
                          borderRadius: UI.radiusControl,
                          padding: "4px 8px",
                          minHeight: "28px",
                          fontSize: "12px"
                        }
                      }, React.createElement("option", { value: "" }, "选择成员"), ...members.filter((member) => member.role === "teammate" && !member.deleted && !member.retired).map((member) => React.createElement("option", { key: member.target, value: member.target }, member.displayName ?? member.target))) : null,
                      state === "pending" ? React.createElement(Btn, { label: "指派", disabled: busy !== null || !taskOwners[task.id], onClick: () => runTask("team_task_update", { task_id: task.id, action: "assign", owner: taskOwners[task.id], expected_revision: task.revision }) }) : null,
                      state === "in_progress" ? React.createElement(Btn, { label: "完成提交", disabled: busy !== null, onClick: () => runTask("team_task_update", { task_id: task.id, action: "complete", expected_revision: task.revision }) }) : null,
                      state === "review" ? React.createElement(Btn, { label: "通过", tone: "primary", disabled: busy !== null, onClick: () => runTask("team_task_update", { task_id: task.id, action: "approve", expected_revision: task.revision }) }) : null,
                      state === "review" ? React.createElement(Btn, {
                        label: "退回",
                        tone: "danger",
                        disabled: busy !== null,
                        onClick: () => {
                          const note = window.prompt("要改什么？", "");
                          if (typeof note !== "string" || note.trim() === "") return;
                          void runTask("team_task_update", { task_id: task.id, action: "reject", review_note: note.trim(), expected_revision: task.revision });
                        }
                      }) : null
                    )
                    : null
                );
              })]
            )
          );
        }

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
                React.createElement(Field, { value: newMemberModel, onInput: setNewMemberModel, placeholder: "provider/model（可选）", width: "170px" }),
                React.createElement(Btn, { label: "创建", tone: "primary", disabled: busy !== null, onClick: runAdd })
              )
            ]
          )
        );
      }

      return React.createElement("div", {
        // No inner scroll container. Nested `overflow:auto` + `height:100%` on a
        // flex item with an indefinite height swallowed the wheel: the inner box
        // never overflowed by its own measure and the outer one sat behind it.
        // The host of this console (panel body / settings page) owns scrolling.
        style: {
          padding: "16px 18px 24px",
          maxWidth: "760px",
          margin: "0 auto",
          boxSizing: "border-box"
        }
      }, ...children);
    }

    // -------------------------------------------------------- header action

    /**
     * The Agent Team button in the session header.
     *
     * The kernel's own button keeps its open/close state inside its component
     * closure and routes through no replaceable service, so it cannot be
     * repointed — but this slot is public and it hands the component `sessionId`,
     * which is exactly the handle our console needs (no guessing from the URL).
     */
    function TeamHeaderAction({ sessionId }) {
      const [open, setOpen] = React.useState(false);
      // Wheel over the floating panel scrolls the panel, never the chat behind it.
      // Native scrolling alone was unreliable inside a fixed layer, so this drives
      // scrollTop directly and only prevents the default when it actually moved.
      // It must re-run on `open`: the body element does not exist while closed.
      const panelBodyRef = React.useRef(null);
      React.useEffect(() => {
        const element = panelBodyRef.current;
        if (!open || element === null || element === undefined) return undefined;
        const onWheel = (event) => {
          if (event.ctrlKey) return;
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
          const before = element.scrollTop;
          element.scrollTop = before + event.deltaY * unit;
          if (element.scrollTop !== before) event.preventDefault();
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
      }, [open]);
      const scope = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            title: "Agent Team 控制台",
            onClick: () => setOpen((value) => !value),
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              background: open ? "var(--dsw-alias-interactive-secondary-bg, rgba(140, 140, 140, 0.14))" : "transparent",
              border: UI.borderSoft,
              minHeight: "28px",
              padding: "4px 12px",
              borderRadius: "999px",
              color: "inherit",
              borderRadius: "6px",
              padding: "3px 8px",
              fontSize: "12px",
              cursor: "pointer"
            }
          },
          "Agent Team"
        ),
        open
          ? React.createElement(
            "div",
            {
              style: {
                position: "fixed",
                zIndex: 60,
                top: "60px",
                right: "18px",
                width: "min(460px, calc(100vw - 36px))",
                maxHeight: "min(78dvh, 760px)",
                display: "flex",
                flexDirection: "column",
                background: UI.surface,
                border: UI.border,
                borderRadius: UI.radiusPanel,
                boxShadow: UI.shadow,
                overflow: "hidden"
              }
            },
            React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "10px 16px",
                  flex: "0 0 auto",
                  borderBottom: UI.borderSoft,
                  background: UI.surfaceSoft
                }
              },
              React.createElement("span", { style: { fontSize: "12px", color: TONE.muted } }, scope === undefined ? "当前会话" : scope.slice(0, 8)),
              React.createElement(Btn, { label: "关闭", onClick: () => setOpen(false) })
            ),
            React.createElement("div", {
              className: "dtc-scroll",
              ref: (element) => {
                panelBodyRef.current = element;
              },
              style: { flex: "1 1 auto", minHeight: "0", overflowY: "auto", overscrollBehavior: "contain" }
            },
              React.createElement(TeamConsole, { fixedSession: scope })
            )
          )
          : null
      );
    }

    // ------------------------------------------------------------------ apply

    return {
      name: "team-conductor-ui",
      inject: ["slots"],
      apply(ctx) {
        const diag = { toolCards: null, settingsSection: null, retries: 0 };
        // Parked for the member rows: opening a member's conversation needs the
        // navigation service, and the rows are plain components without ctx.
        try {
          window.__dshTeamConductorCtx = ctx;
        } catch {
          /* no window (should not happen in the browser half) */
        }

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

        // Same slot as the kernel's own Agent Teams button (id `agent-team`,
        // order -20); this one sits beside it so both can be compared before
        // deciding whether to disable the kernel UI.
        stage("headerAction", () =>
          ctx.slots.inject("conversation.session.header.actions", () =>
            ctx.slots.register(
              {
                name: "conversation.session.header.actions",
                id: "agent-team-conductor",
                order: -19
              },
              TeamHeaderAction
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
