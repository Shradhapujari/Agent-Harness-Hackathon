const graph = [
  ["N0", "Watch", "Detecting an alert storm"],
  ["N1", "Triage", "Correlating one root cause"],
  ["N2", "Enrich", "Agents gathering cross-layer evidence"],
  ["N3", "Plan", "Ranking safe and destructive actions"],
  ["N4", "Route", "Applying the fixed tool policy"],
  ["N5", "Execute safe", "Running reversible remediation"],
  ["N6", "Approve", "Waiting for human authority"],
  ["N7", "Execute gated", "Resuming the approved tool call"],
  ["N8", "Verify", "Checking code-owned recovery predicates"],
  ["N9", "Escalate", "Paging an operator with evidence"],
  ["N10", "Report", "Writing the audit record"]
];
const nodeOrder = Object.fromEntries(graph.map(([id], index) => [id, index]));
const $ = (id) => document.getElementById(id);
let lastStatus;
let activeApprovalId;
let activeApprovalRunId;
let toastTimer;

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
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setService(dotId, labelId, service, online, offline) {
  const dot = $(dotId);
  dot.className = `service-dot ${service?.ok ? "ok" : "warn"}`;
  $(labelId).textContent = service?.ok ? online : offline;
}

function renderGraph(state, running) {
  const list = $("agent-list");
  const activeIndex =
    state?.node === "DONE" ? graph.length : (nodeOrder[state?.node] ?? -1);
  list.replaceChildren(
    ...graph.map(([id, title, detail], index) => {
      const row = node("li", "agent-step");
      if (index < activeIndex || state?.node === "DONE")
        row.classList.add("done");
      else if (index === activeIndex && running) row.classList.add("active");
      else row.classList.add("waiting");
      row.append(node("span", "agent-marker"), node("span", "agent-node", id));
      const copy = node("div", "agent-detail");
      copy.append(node("strong", "", title), node("span", "", detail));
      row.append(copy);
      return row;
    })
  );
}

function renderEvidence(evidence = []) {
  $("evidence-count").textContent =
    `${evidence.length} ${evidence.length === 1 ? "record" : "records"}`;
  const list = $("evidence-list");
  if (!evidence.length) {
    list.replaceChildren(
      node(
        "div",
        "empty-state",
        "Evidence will collect here as the agents inspect the rack."
      )
    );
    return;
  }
  list.replaceChildren(
    ...evidence.map((item) => {
      const row = node("div", "evidence-row");
      row.append(
        node("span", "layer-tag", item.layer),
        node("p", "", item.summary),
        node(
          "span",
          "source-tag",
          item.source === "fallback" ? "FALLBACK" : "LIVE"
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
      node("div", "empty-state", "No remediation has been proposed.")
    );
    return;
  }
  list.replaceChildren(
    ...[...actions]
      .sort((a, b) => a.rank - b.rank)
      .map((item) => {
        const row = node("div", "action-row");
        const copy = node("div");
        copy.append(node("strong", "", item.tool), node("p", "", item.reason));
        const status = node(
          "span",
          `action-status ${item.status}`,
          item.status
        );
        status.title = item.decidedBy
          ? `Decided by ${item.decidedBy}`
          : item.kind;
        row.append(
          node("span", "action-rank", String(item.rank).padStart(2, "0")),
          copy,
          status
        );
        return row;
      })
  );
}

function rootCauseLabel(kind) {
  return (
    {
      crac_failure: "Rack cooling failure",
      host_hang: "Host R4-N04 is hung",
      psu_failure: "Power supply failure",
      thermal_single: "Isolated thermal fault",
      unknown: "Cause not yet resolved"
    }[kind] ?? "Cause not yet resolved"
  );
}

function renderFinding(state) {
  const finding = $("incident-finding");
  finding.replaceChildren();
  const label = node("p", "", "Root cause");
  const title = node(
    "h3",
    "",
    state?.incident
      ? rootCauseLabel(state.incident.rootCause.kind)
      : "Signal under investigation"
  );
  const detail = node(
    "span",
    "",
    state?.incident
      ? `${Math.round(state.incident.rootCause.confidence * 100)}% confidence · ${state.incident.rootCause.rationale}`
      : "Hush will name the source after the alarm storm is correlated."
  );
  finding.append(label, title, detail);
}

function addFact(list, term, value) {
  list.append(node("dt", "", term), node("dd", "", value));
}

function renderApproval(approval) {
  const drawer = $("approval-drawer");
  if (!approval?.action) {
    activeApprovalId = undefined;
    activeApprovalRunId = undefined;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    return;
  }
  activeApprovalId = approval.action.id;
  activeApprovalRunId = approval.runId;
  const action = approval.action;
  $("approval-title").textContent = `${action.tool} is paused`;
  $("approval-summary").textContent = action.reason;
  const facts = $("approval-facts");
  facts.replaceChildren();
  addFact(
    facts,
    "Target",
    String(action.args?.system_id ?? action.args?.node ?? "See arguments")
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
    (action.evidence ?? []).join(", ") || "No evidence IDs supplied"
  );
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  if (document.activeElement === document.body) $("approve").focus();
}

function elapsed(iso) {
  if (!iso) return "00:00";
  const total = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function render(status) {
  lastStatus = status;
  const { state, process, services, runId } = status;
  const stackReady = services.bmc.ok && services.alertmanager.ok;
  $("global-dot").className = `status-dot ${stackReady ? "ok" : "warn"}`;
  $("global-status").textContent = stackReady
    ? "Local stack connected"
    : "Local services need attention";
  setService("bmc-dot", "bmc-label", services.bmc, "Online", "Offline");
  setService(
    "alert-dot",
    "alert-label",
    services.alertmanager,
    "Ready",
    "Offline"
  );
  $("harness-dot").className =
    `service-dot ${process.running ? "ok" : process.error ? "warn" : ""}`;
  $("harness-label").textContent = process.running
    ? "Working"
    : process.error
      ? "Stopped"
      : "Standing by";
  $("run-id").textContent = runId ?? "—";
  $("elapsed").textContent = elapsed(process.startedAt);
  $("trigger").disabled = process.running || !stackReady;
  $("trigger-label").textContent = process.running
    ? "Incident running"
    : "Trigger alarm";

  const hasSignal = Boolean(process.running || state);
  $("active-trace").classList.toggle("visible", hasSignal);
  $("cursor-line").classList.toggle("visible", process.running);
  $("epicenter").classList.toggle("active", hasSignal);
  $("epicenter-label").textContent = state?.incident
    ? rootCauseLabel(state.incident.rootCause.kind)
    : hasSignal
      ? "Locating epicenter"
      : "Awaiting signal";
  $("live-chip").textContent = process.running
    ? "LIVE TRACE"
    : state?.node === "DONE"
      ? "COMPLETE"
      : "STANDBY";
  $("live-chip").classList.toggle("active", process.running);
  $("trace-caption").textContent = process.running
    ? `${state?.alerts?.length ?? 0} firing signals · agent graph at ${state?.node ?? "N0"}`
    : state?.outcome
      ? `Incident closed · outcome ${state.outcome}`
      : "Nominal baseline. No incident is active.";

  renderGraph(state, process.running);
  renderFinding(state);
  renderEvidence(state?.evidence);
  renderActions(state?.actions);
  renderApproval(status.approval);
  if (process.error)
    $("trace-caption").textContent =
      `${process.error}. Check the local terminal output.`;
}

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`status returned ${response.status}`);
    render(await response.json());
  } catch (error) {
    $("global-dot").className = "status-dot warn";
    $("global-status").textContent = "Console connection lost";
    $("trigger").disabled = true;
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
  if (!activeApprovalId || !activeApprovalRunId) return;
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
      body: JSON.stringify({
        runId: activeApprovalRunId,
        actionId: activeApprovalId,
        allow,
        reason
      })
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "decision was not accepted");
    showToast(
      allow
        ? "Approved. The exact tool call will resume."
        : "Denied. Hush will replan with your note."
    );
    $("deny-reason").value = "";
    activeApprovalId = undefined;
    activeApprovalRunId = undefined;
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

function tickClock() {
  $("clock").textContent = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());
  if (lastStatus?.process?.startedAt)
    $("elapsed").textContent = elapsed(lastStatus.process.startedAt);
}

renderGraph(undefined, false);
$("trigger").addEventListener("click", triggerIncident);
$("approve").addEventListener("click", () => decide(true));
$("deny").addEventListener("click", () => decide(false));
tickClock();
refresh();
setInterval(tickClock, 1000);
setInterval(refresh, 1200);
