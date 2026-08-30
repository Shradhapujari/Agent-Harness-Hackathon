/*
 * Hush operator console.
 *
 * Everything drawn here comes from `/api/status`, which returns the run's real
 * `state.json`. There are no decorative traces: the storm lanes plot the actual
 * `startsAt` of every alert against its `labels.layer`, and the graph relay is
 * timed from `state.timeline`.
 */

const GRAPH = [
  ["N0", "Watch", "Detect an alert storm"],
  ["N1", "Triage", "Correlate one root cause"],
  ["N2", "Enrich", "Gather cross-layer evidence"],
  ["N3", "Plan", "Rank safe and destructive actions"],
  ["N4", "Route", "Apply the fixed tool policy"],
  ["N5", "Execute safe", "Run reversible remediation"],
  ["N6", "Approve", "Wait for human authority"],
  ["N7", "Execute gated", "Resume the approved call"],
  ["N8", "Verify", "Check recovery predicates"],
  ["N9", "Escalate", "Page an operator with evidence"],
  ["N10", "Report", "Write the audit record"]
];

const NODE_INDEX = Object.fromEntries(GRAPH.map(([id], index) => [id, index]));

/*
 * Lanes are ordered by causal depth, lowest layer first. That ordering is the
 * point: triage names the earliest alert in the lowest lane as the cause, so
 * the reader can check the verdict against the picture.
 */
const LAYERS = [
  ["facility", "facility"],
  ["bmc", "bmc"],
  ["network", "network"],
  ["kubernetes", "kubernetes"],
  ["app", "app"]
];

const ROOT_CAUSE_LABEL = {
  crac_failure: "Rack cooling failure",
  host_hang: "Host hang",
  psu_failure: "Power supply failure",
  thermal_single: "Isolated thermal fault",
  unknown: "Cause not yet resolved"
};

const WARNING_EVENTS = new Set([
  "parse_error",
  "plan_parse_error",
  "enrich_fallback_escalation",
  "action_failed",
  "run_timeout",
  "denied"
]);

const SETTLED_EVENTS = new Set([
  "action_executed",
  "approved",
  "report_written",
  "verification"
]);

const OUTCOME_TONE = {
  recovered: "var(--ok)",
  escalated: "var(--sev-warning)",
  aborted: "var(--sev-critical)"
};

const OUTCOME_NOTE = {
  recovered: "Verification predicates passed.",
  escalated: "Handed to an operator with the evidence.",
  aborted: "The run stopped before remediation."
};

const $ = (id) => document.getElementById(id);

let lastStatus;
let activeApproval;
let toastTimer;
// Whether the checkpoint currently holds focus, and where to hand it back.
let approvalOpen = false;
let returnFocusTo;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function rootCauseLabel(kind) {
  return ROOT_CAUSE_LABEL[kind] ?? "Cause not yet resolved";
}

function clock(iso) {
  return iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--";
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

function elapsed(iso) {
  if (!iso) return "00:00";
  const total = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60
  ).padStart(2, "0")}`;
}

function humanize(event) {
  return event.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase());
}

function scalar(value) {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value))
    return value.length <= 3
      ? value.map(scalar).join(",")
      : `${value.length} items`;
  if (typeof value === "object")
    return Object.entries(value)
      .map(([key, inner]) => `${key}:${scalar(inner)}`)
      .join(" ");
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function detailText(detail) {
  if (detail === undefined || detail === null) return "";
  if (typeof detail !== "object") return String(detail);
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${scalar(value)}`)
    .join("  ");
}

/** Which bucket triage put each alert in. Everything is unsorted before N1. */
function roleOf(fingerprint, incident) {
  if (!incident) return "unsorted";
  if (incident.primary?.includes(fingerprint)) return "primary";
  if (incident.symptoms?.includes(fingerprint)) return "symptom";
  if (incident.noise?.includes(fingerprint)) return "noise";
  return "unsorted";
}

/* ── 1 · Verdict ────────────────────────────────────────────────── */

function renderVerdict(state, running) {
  const alerts = state?.alerts ?? [];
  const incident = state?.incident;
  $("alarm-count").textContent = String(alerts.length);
  $("cause-count").textContent = incident ? "1" : "0";

  if (incident) {
    const scope = incident.rootCause.scope;
    const nodes = scope.nodes?.length
      ? scope.nodes.join(", ")
      : "no host named";
    $("root-cause").textContent = rootCauseLabel(incident.rootCause.kind);
    $("root-scope").textContent =
      `${scope.rack ? `Rack ${scope.rack} · ` : ""}${nodes} — ${incident.rootCause.rationale}`;
  } else if (alerts.length) {
    $("root-cause").textContent = "Correlating the storm";
    $("root-scope").textContent =
      "Hush names the cause once N1 has separated the primary alert from its downstream symptoms.";
  } else {
    $("root-cause").textContent = running
      ? "Listening for the storm"
      : "Nominal baseline";
    $("root-scope").textContent = running
      ? "The fault is injected. N0 holds until enough alerts fire inside the window."
      : "No incident is active. Trigger a fault to watch the graph run end to end.";
  }

  const confidence = $("confidence");
  if (incident) {
    const percent = Math.round(incident.rootCause.confidence * 100);
    confidence.hidden = false;
    $("confidence-value").textContent = `${percent}%`;
    $("confidence-bar").style.width = `${percent}%`;
  } else {
    confidence.hidden = true;
    $("confidence-bar").style.width = "0%";
  }

  renderSplit(alerts, incident);
}

function renderSplit(alerts, incident) {
  const counts = { primary: 0, symptom: 0, noise: 0, unsorted: 0 };
  for (const alert of alerts) counts[roleOf(alert.fingerprint, incident)] += 1;

  const order = [
    ["primary", "root cause", "var(--accent)"],
    ["symptom", "downstream symptoms", "var(--ink-tertiary)"],
    ["noise", "unrelated noise", "var(--hairline-tertiary)"],
    ["unsorted", "not yet correlated", "var(--ink-subtle)"]
  ];

  $("split-bar").replaceChildren(
    ...order
      .filter(([key]) => counts[key] > 0)
      .map(([key]) => {
        const segment = node("span", `is-${key}`);
        segment.style.flex = `${counts[key]} 0 0`;
        return segment;
      })
  );

  $("split-key").replaceChildren(
    ...order
      .filter(([key]) => counts[key] > 0 || key === "primary")
      .map(([key, label, tone]) => {
        const group = node("div");
        const swatch = node("i");
        swatch.style.background = tone;
        const term = node("dt", "", label);
        const value = node("dd", "", String(counts[key]));
        group.append(swatch, value, term);
        return group;
      })
  );
}

/* ── 2a · Storm ─────────────────────────────────────────────────── */

function renderSeverity(alerts) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const alert of alerts) counts[alert.severity] += 1;
  const tones = {
    critical: "var(--sev-critical)",
    warning: "var(--sev-warning)",
    info: "var(--ink-subtle)"
  };

  $("severity-strip").replaceChildren(
    ...["critical", "warning", "info"].map((severity) => {
      const tile = node("div", "sev-tile");
      tile.style.setProperty("--tone", tones[severity]);
      tile.append(
        node("b", "", String(counts[severity])),
        node("span", "", severity)
      );
      return tile;
    })
  );
}

/*
 * A time scale that keeps the ordering honest but spends its width on the
 * alerts. A single stale alert — the isolated CpuTempCritical triage calls
 * noise — can sit half an hour before the storm and squeeze forty burst alerts
 * into one column. Idle stretches longer than IDLE_GAP collapse to a fixed
 * width and are marked with a dashed rule, so the reader sees "nothing
 * happened here" rather than losing the burst.
 */
// The plotting band inside a lane track, as percentages, and how co-timed pips
// fan within it. Every pip must land inside [PIP_MIN_X, PIP_MIN_X + PIP_SPAN];
// the track clips anything past its edge.
const PIP_MIN_X = 4;
const PIP_SPAN = 92;
const PIP_ROWS = 3;
const PIP_STEP = 1.6;

const IDLE_GAP = 0.12;
const COLLAPSED_GAP = 0.06;
// A whole storm can land inside ten seconds; nothing in there is "idle", so
// only a gap that is both dominant and genuinely long is worth collapsing.
const IDLE_GAP_MS = 30_000;

function timeScale(times) {
  const stops = [...new Set(times)].sort((left, right) => left - right);
  const span = Math.max(stops.at(-1) - stops[0], 1);
  const position = new Map([[stops[0], 0]]);
  const breaks = [];
  let offset = 0;

  for (let index = 1; index < stops.length; index += 1) {
    const elapsedMs = stops[index] - stops[index - 1];
    const gap = elapsedMs / span;
    const idle = gap > IDLE_GAP && elapsedMs > IDLE_GAP_MS;
    const step = idle ? COLLAPSED_GAP : gap;
    if (idle) breaks.push(offset + step / 2);
    offset += step;
    position.set(stops[index], offset);
  }

  const total = offset || 1;
  return {
    at: (time) => position.get(time) / total,
    breaks: breaks.map((value) => value / total),
    collapsed: breaks.length > 0
  };
}

function renderLanes(alerts, incident) {
  const lanes = $("lanes");
  const axis = $("lane-axis");
  if (!alerts.length) {
    axis.hidden = true;
    lanes.replaceChildren(
      node(
        "p",
        "empty",
        "Lanes fill from the lowest layer up as alerts arrive."
      )
    );
    return;
  }

  // The axis spans the alerts themselves, not "now". Stretching it to the
  // current time squeezes the whole storm into a sliver as the run goes on,
  // and the reading that matters here is which alert arrived before which.
  const times = alerts.map((alert) => Date.parse(alert.startsAt));
  const start = Math.min(...times);
  const end = Math.max(...times);
  const scale = timeScale(times);

  const present = LAYERS.filter(([layer]) =>
    alerts.some((alert) => (alert.labels.layer ?? "other") === layer)
  );
  const other = alerts.some(
    (alert) => !LAYERS.some(([layer]) => layer === (alert.labels.layer ?? ""))
  );
  const rows = other ? [...present, ["other", "other"]] : present;

  lanes.replaceChildren(
    ...rows.map(([layer, label]) => {
      const inLane = alerts.filter((alert) => {
        const value = alert.labels.layer ?? "";
        return layer === "other"
          ? !LAYERS.some(([known]) => known === value)
          : value === layer;
      });

      const row = node("div", "lane");
      const track = node("div", "lane-track");

      for (const at of scale.breaks) {
        const rule = node("i", "lane-break");
        rule.style.left = `${PIP_MIN_X + at * PIP_SPAN}%`;
        track.append(rule);
      }

      /*
       * hush-chaos posts a whole layer's symptoms in one call, so a dozen
       * alerts can share a millisecond and land on the same pixel. Group the
       * collisions and fan each group across three sub-rows, centred on its own
       * timestamp and held inside the track: a burst at the very last instant
       * of the storm — six Kubernetes alerts per node, three nodes — would
       * otherwise run off the right edge and be clipped, and the marks a reader
       * can count have to match the lane's own count.
       */
      const groups = new Map();
      for (const alert of [...inLane].sort(
        (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt)
      )) {
        const base =
          PIP_MIN_X + scale.at(Date.parse(alert.startsAt)) * PIP_SPAN;
        const key = Math.round(base);
        if (!groups.has(key)) groups.set(key, { base, members: [] });
        groups.get(key).members.push(alert);
      }

      for (const { base, members } of groups.values()) {
        const columns = Math.ceil(members.length / PIP_ROWS);
        // Tighten the step rather than overflow if a single instant ever
        // collects more alerts than the track can hold at the normal spacing.
        const step =
          columns > 1 ? Math.min(PIP_STEP, PIP_SPAN / (columns - 1)) : PIP_STEP;
        const width = (columns - 1) * step;
        const start = Math.min(
          Math.max(base - width / 2, PIP_MIN_X),
          PIP_MIN_X + PIP_SPAN - width
        );

        members.forEach((alert, seat) => {
          const pip = node("b", "pip");
          pip.style.left = `${start + Math.floor(seat / PIP_ROWS) * step}%`;
          pip.style.top = `calc(50% + ${((seat % PIP_ROWS) - 1) * 7}px)`;
          pip.dataset.severity = alert.severity;
          pip.dataset.role = roleOf(alert.fingerprint, incident);
          pip.title = `${alert.name} · ${alert.labels.node ?? alert.labels.instance ?? layer} · ${alert.severity} · ${clock(alert.startsAt)}`;
          track.append(pip);
        });
      }

      row.append(
        node("span", "lane-name", label),
        node("span", "lane-count", String(inLane.length)),
        track
      );
      return row;
    })
  );

  axis.hidden = false;
  $("axis-start").textContent = clock(new Date(start).toISOString());
  $("axis-mid").textContent = `storm span ${duration(end - start)}${
    scale.collapsed ? " · idle gaps collapsed" : ""
  }`;
  $("axis-end").textContent = clock(new Date(end).toISOString());
}

function renderAlarmGrid(alerts, incident) {
  const grid = $("alarm-grid");
  if (!alerts.length) {
    grid.replaceChildren();
    return;
  }

  const weight = { primary: 0, unsorted: 1, symptom: 2, noise: 3 };
  const tones = {
    critical: "var(--sev-critical)",
    warning: "var(--sev-warning)",
    info: "var(--ink-tertiary)"
  };

  grid.replaceChildren(
    ...[...alerts]
      .sort((left, right) => {
        const byRole =
          weight[roleOf(left.fingerprint, incident)] -
          weight[roleOf(right.fingerprint, incident)];
        return byRole || Date.parse(left.startsAt) - Date.parse(right.startsAt);
      })
      .map((alert) => {
        const role = roleOf(alert.fingerprint, incident);
        const cell = node("div", "alarm");
        cell.dataset.role = role;
        cell.style.setProperty("--tone", tones[alert.severity]);
        cell.title = `${alert.name} · ${alert.severity} · ${role} · ${clock(alert.startsAt)} · ${alert.fingerprint}`;
        cell.append(
          node("span", "alarm-name", alert.name),
          node(
            "span",
            "alarm-node",
            alert.labels.node ?? alert.labels.rack ?? "—"
          )
        );
        return cell;
      })
  );
}

function renderStorm(state, running) {
  const alerts = state?.alerts ?? [];
  const chip = $("live-chip");
  chip.classList.toggle("live", Boolean(running));
  chip.classList.toggle("done", !running && state?.node === "DONE");
  chip.textContent = running
    ? "Live"
    : state?.node === "DONE"
      ? "Complete"
      : "Standby";

  $("storm-caption").textContent = alerts.length
    ? `${alerts.length} firing alerts placed on their real arrival time and layer.`
    : "Every firing alert, placed on its real arrival time and infrastructure layer.";

  renderSeverity(alerts);
  renderLanes(alerts, state?.incident);
  renderAlarmGrid(alerts, state?.incident);
}

/* ── 2b · Agent graph ───────────────────────────────────────────── */

/*
 * Per-node timings.
 *
 * A timeline entry carries the clock reading from the moment its node *returns*
 * — `route` builds `timeline(context.clock(), "N4", …)` inside the patch it
 * hands back, and `run` only merges that patch afterwards. So a `ts` closes an
 * interval rather than opening one: the time between two consecutive entries
 * belongs to the node that wrote the *later* one. Subtracting the other way
 * round shifts every duration one node earlier and hands N4 the human approval
 * wait that N6 actually spent.
 *
 * Nodes are also revisited — a replan returns to N3 and N4, verification retries
 * re-enter N8 — so intervals accumulate per node instead of being taken once.
 * Several entries from one node in a single visit simply split that node's own
 * interval into pieces that add back up.
 *
 * A node with no entry at all never did work (N9 stays silent on a run that
 * recovered), which is what lets the relay tell "ran" from "skipped" rather than
 * assuming everything before the cursor completed.
 */
function nodeTimings(timeline = [], runStartedAt, liveNode) {
  const events = timeline
    .map((entry) => ({ node: entry.nodeId, at: Date.parse(entry.ts) }))
    .filter((event) => Number.isFinite(event.at))
    .sort((left, right) => left.at - right.at);

  const entered = new Map();
  const spent = new Map();
  let previous = Date.parse(runStartedAt ?? "");
  if (!Number.isFinite(previous)) previous = events[0]?.at;

  for (const event of events) {
    if (!entered.has(event.node)) entered.set(event.node, event.at);
    spent.set(event.node, (spent.get(event.node) ?? 0) + (event.at - previous));
    previous = event.at;
  }

  // The live node has not closed its interval yet; run it up to now so the
  // relay ticks while the operator watches.
  if (liveNode && Number.isFinite(previous))
    spent.set(liveNode, (spent.get(liveNode) ?? 0) + (Date.now() - previous));

  return { entered, spent };
}

function renderRelay(state, running) {
  const complete = state?.node === "DONE";
  const activeIndex = complete ? GRAPH.length : (NODE_INDEX[state?.node] ?? -1);
  const liveNode = running ? state?.node : undefined;
  const { entered, spent } = nodeTimings(
    state?.timeline,
    state?.runStartedAt,
    liveNode
  );

  $("relay-position").textContent = complete
    ? "Complete"
    : activeIndex >= 0
      ? `${state.node} / N10`
      : "Not started";

  // The caption carries the running node's own description, so the panel says
  // what the agent is doing right now rather than restating the graph.
  const activeDetail = GRAPH[activeIndex]?.[2];
  $("relay-caption").textContent =
    running && activeDetail
      ? activeDetail
      : "Eleven nodes, in execution order.";

  $("relay-list").replaceChildren(
    ...GRAPH.map(([id, title, detail], index) => {
      const row = node("li", "relay-step");
      const at = entered.get(id);
      const isActive = index === activeIndex && running;

      if (isActive) row.classList.add("active");
      else if (at !== undefined) row.classList.add("done");
      else if (complete || index < activeIndex) row.classList.add("skipped");

      const ms = spent.get(id);
      let timing = ms !== undefined ? duration(ms) : "";
      if (at === undefined && row.classList.contains("skipped"))
        timing = "skipped";

      row.title = `${id} · ${title} — ${detail}`;
      row.append(
        node("span", "relay-marker"),
        node("span", "relay-node", id),
        node("span", "relay-title", title),
        node("span", "relay-timing", timing)
      );
      return row;
    })
  );

  renderCounters(state);
}

function renderCounters(state) {
  const counters = state?.counters ?? {
    replans: 0,
    parseRetries: 0,
    verifyAttempts: 0
  };
  const list = $("counters");
  list.replaceChildren(
    ...[
      ["replans", counters.replans, counters.replans > 0],
      ["parse retries", counters.parseRetries, counters.parseRetries > 0],
      ["verify attempts", counters.verifyAttempts, false]
    ].map(([label, value, flagged]) => {
      const group = node("div", flagged ? "flagged" : undefined);
      group.append(node("dt", "", label), node("dd", "", String(value ?? 0)));
      return group;
    })
  );

  const slot = $("outcome-slot");
  if (!state?.outcome) {
    slot.replaceChildren();
    return;
  }
  const banner = node("div", "outcome");
  banner.style.setProperty("--tone", OUTCOME_TONE[state.outcome]);
  banner.append(
    node("b", "", state.outcome),
    node("span", "", OUTCOME_NOTE[state.outcome] ?? "")
  );
  slot.replaceChildren(banner);
}

/* ── 3 · Timeline ───────────────────────────────────────────────── */

function renderTimeline(timeline = []) {
  $("timeline-count").textContent =
    `${timeline.length} ${timeline.length === 1 ? "event" : "events"}`;
  const list = $("timeline");
  if (!timeline.length) {
    list.replaceChildren(
      node(
        "li",
        "empty",
        "The controller records each node transition here as it runs."
      )
    );
    return;
  }

  list.replaceChildren(
    ...timeline.map((entry) => {
      const row = node("li");
      if (WARNING_EVENTS.has(entry.event)) row.classList.add("alarming");
      else if (SETTLED_EVENTS.has(entry.event)) row.classList.add("terminal");
      const detail = detailText(entry.detail);
      const cell = node("span", "event-detail", detail);
      cell.title = detail;
      row.append(
        node("span", "event-time", clock(entry.ts)),
        node("span", "event-node", entry.nodeId),
        node("span", "event-name", humanize(entry.event)),
        cell
      );
      return row;
    })
  );
  list.scrollTop = list.scrollHeight;
}

/* ── 4 · Evidence and actions ───────────────────────────────────── */

function renderEvidence(evidence = []) {
  $("evidence-count").textContent =
    `${evidence.length} ${evidence.length === 1 ? "record" : "records"}`;
  const list = $("evidence-list");
  if (!evidence.length) {
    list.replaceChildren(
      node(
        "p",
        "empty",
        "Evidence collects here as the agents inspect the rack."
      )
    );
    return;
  }

  list.replaceChildren(
    ...evidence.map((item) => {
      const row = node("div", "record");
      const body = node("div", "record-body");
      body.append(node("p", "", item.summary));
      row.append(
        node("span", "tag", item.layer),
        body,
        node(
          "span",
          item.source === "fallback" ? "tag fallback" : "tag",
          item.source === "fallback" ? "fallback" : "live"
        )
      );
      return row;
    })
  );
}

function renderActions(actions = []) {
  $("action-count").textContent =
    `${actions.length} ${actions.length === 1 ? "action" : "actions"}`;
  const list = $("action-list");
  if (!actions.length) {
    list.replaceChildren(
      node("p", "empty", "No remediation has been proposed.")
    );
    return;
  }

  list.replaceChildren(
    ...[...actions]
      .sort((left, right) => left.rank - right.rank)
      .map((item) => {
        const row = node(
          "div",
          item.kind === "destructive" ? "record destructive" : "record"
        );
        const body = node("div", "record-body");
        body.append(node("strong", "", item.tool), node("p", "", item.reason));
        const status = node("span", `status ${item.status}`, item.status);
        status.title = item.decidedBy
          ? `${item.kind} · decided by ${item.decidedBy}`
          : item.kind;
        row.append(
          node("span", "rank", String(item.rank).padStart(2, "0")),
          body,
          status
        );
        return row;
      })
  );
}

/* ── Approval ───────────────────────────────────────────────────── */

function addFact(list, term, value) {
  list.append(node("dt", "", term), node("dd", "", value));
}

function renderApproval(approval) {
  const drawer = $("approval-drawer");
  if (!approval?.action) {
    activeApproval = undefined;
    // Hand focus back before hiding, so `aria-hidden` is never set on a subtree
    // that still holds the focused element.
    if (approvalOpen) {
      approvalOpen = false;
      if (drawer.contains(document.activeElement))
        (returnFocusTo?.isConnected ? returnFocusTo : document.body).focus?.();
      returnFocusTo = undefined;
    }
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    return;
  }

  const action = approval.action;
  activeApproval = {
    runId: approval.runId,
    actionId: action.id,
    toolCallId: approval.pending?.toolCallId
  };

  $("approval-title").textContent = `${action.tool} is paused`;
  $("approval-summary").textContent = action.reason;
  const facts = $("approval-facts");
  facts.replaceChildren();
  addFact(
    facts,
    "Target",
    String(action.args?.system_id ?? action.args?.node ?? "see arguments")
  );
  addFact(facts, "Arguments", JSON.stringify(action.args));
  addFact(
    facts,
    "Root cause",
    rootCauseLabel(approval.incident?.rootCause?.kind)
  );
  addFact(
    facts,
    "Evidence",
    (action.evidence ?? []).join(", ") || "no evidence IDs supplied"
  );

  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");

  /*
   * The checkpoint appears from a poll, not from a click, so nothing would move
   * focus to it on its own and a keyboard or screen-reader operator could keep
   * working the page behind a surface that is holding the run. Move focus to
   * the drawer the first time it opens — the `aria-labelledby`/`describedby`
   * pair announces which call is paused and why.
   *
   * Only on the transition: `render` runs on every poll, and stealing focus
   * each time would empty the caret out of the denial note as it is typed.
   *
   * The background is deliberately left reachable rather than inert: the
   * evidence and action registers behind the drawer are exactly what an
   * operator needs to read before deciding.
   */
  if (!approvalOpen) {
    approvalOpen = true;
    returnFocusTo =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : undefined;
    drawer.focus();
  }
}

/* ── Wiring ─────────────────────────────────────────────────────── */

function setService(id, ok, online, offline, live) {
  const element = $(id);
  element.className = `svc ${live ? "live" : ok ? "ok" : "warn"}`;
  element.querySelector("b").textContent = live ? live : ok ? online : offline;
}

function render(status) {
  lastStatus = status;
  const { state, process, services, runId } = status;
  const stackReady = services.bmc.ok && services.alertmanager.ok;
  const running = Boolean(process.running);

  setService("svc-bmc", services.bmc.ok, "online", "offline");
  setService(
    "svc-alertmanager",
    services.alertmanager.ok,
    "ready",
    (services.alertmanager.detail ?? "offline").slice(0, 28)
  );
  setService(
    "svc-harness",
    !process.error,
    state?.node === "DONE" ? "complete" : "standing by",
    "stopped",
    running ? (state?.node ?? "starting") : undefined
  );

  $("run-id").textContent = runId ?? "no run";
  $("elapsed").textContent = elapsed(process.startedAt);
  $("trigger").disabled = running || !stackReady;
  $("trigger-label").textContent = running
    ? "Incident running"
    : stackReady
      ? "Trigger alarm"
      : "Stack offline";

  renderVerdict(state, running);
  renderStorm(state, running);
  renderRelay(state, running);
  renderTimeline(state?.timeline);
  renderEvidence(state?.evidence);
  renderActions(state?.actions);
  renderApproval(status.approval);

  $("stdout").textContent = process.output?.length
    ? process.output.join("\n")
    : process.error
      ? process.error
      : "Nothing yet.";
}

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`status returned ${response.status}`);
    render(await response.json());
  } catch {
    for (const id of ["svc-bmc", "svc-alertmanager", "svc-harness"]) {
      $(id).className = "svc warn";
      $(id).querySelector("b").textContent = "no console";
    }
    $("trigger").disabled = true;
    $("trigger-label").textContent = "Console unreachable";
  }
}

async function triggerIncident() {
  const button = $("trigger");
  button.disabled = true;
  $("trigger-label").textContent = "Injecting fault…";
  try {
    const response = await fetch("/api/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: $("scenario").value })
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "incident could not start");
    showToast("Fault injected. Hush is watching for the alarm storm.");
    await refresh();
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : "Incident could not start"
    );
    button.disabled = false;
    $("trigger-label").textContent = "Trigger alarm";
  }
}

async function decide(allow) {
  if (!activeApproval?.runId || !activeApproval.actionId) return;
  const reason = $("deny-reason").value.trim();
  if (!allow && !reason) {
    $("deny-reason").focus();
    showToast("Add a decision note so the agent knows why to replan.");
    return;
  }

  $("approve").disabled = true;
  $("deny").disabled = true;
  try {
    const response = await fetch("/api/approval", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...activeApproval, allow, reason })
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "decision was not accepted");
    showToast(
      allow
        ? "Approved. The exact tool call resumes."
        : "Denied. Hush replans with your note."
    );
    $("deny-reason").value = "";
    activeApproval = undefined;
    await refresh();
  } catch (error) {
    showToast(
      error instanceof Error ? error.message : "Decision could not be recorded"
    );
  } finally {
    $("approve").disabled = false;
    $("deny").disabled = false;
  }
}

function tick() {
  if (lastStatus?.process?.startedAt)
    $("elapsed").textContent = elapsed(lastStatus.process.startedAt);
}

renderRelay(undefined, false);
$("trigger").addEventListener("click", triggerIncident);
$("approve").addEventListener("click", () => decide(true));
$("deny").addEventListener("click", () => decide(false));
refresh();
setInterval(tick, 1000);
setInterval(refresh, 1200);
