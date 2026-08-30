import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.HUSH_UI_PORT ?? 4173);
const bmcUrl = process.env.HUSH_BMC_URL ?? "http://127.0.0.1:8100";
const alertmanagerUrl =
  process.env.HUSH_ALERTMANAGER_URL ?? "http://127.0.0.1:9093";
const publicDirectory = fileURLToPath(new URL("../ui/", import.meta.url));
const runsDirectory = resolve(process.env.HUSH_RUNS_DIRECTORY ?? "runs");
const startedAt = new Date().toISOString();
let incidentProcess: ChildProcess | undefined;
let incidentStarting = false;
let incidentRunning = false;
let processStartedAt: number | undefined;
let processError: string | undefined;
const output: string[] = [];
const recordedDecisions = new Set<string>();

type Json = Record<string, unknown>;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Json;
}

async function fetchStatus(
  url: string
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1400) });
    return {
      ok: response.ok,
      ...(!response.ok ? { detail: `HTTP ${response.status}` } : {})
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "unreachable"
    };
  }
}

async function latestRunId(): Promise<string | undefined> {
  try {
    const entries = await readdir(runsDirectory, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && /^inc-\d{8}-[0-9a-fA-F]{4}$/.test(entry.name)
        )
        .map(async (entry) => ({
          name: entry.name,
          time: (await stat(join(runsDirectory, entry.name))).mtimeMs
        }))
    );
    const minimumTime =
      (incidentStarting || incidentRunning) && processStartedAt
        ? processStartedAt - 1_000
        : 0;
    return candidates
      .filter((candidate) => candidate.time >= minimumTime)
      .sort((left, right) => right.time - left.time)[0]?.name;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function status(): Promise<Json> {
  const runId = await latestRunId();
  const [bmc, alertmanager] = await Promise.all([
    fetchStatus(`${bmcUrl}/chaos/status`),
    fetchStatus(`${alertmanagerUrl}/-/ready`)
  ]);
  return {
    server: { ok: true, startedAt },
    services: { bmc, alertmanager },
    process: {
      running: incidentStarting || incidentRunning,
      startedAt: processStartedAt
        ? new Date(processStartedAt).toISOString()
        : undefined,
      error: processError,
      output: output.slice(-40)
    },
    runId,
    state: runId
      ? await readJson(join(runsDirectory, runId, "state.json"))
      : undefined,
    approval: runId
      ? await readJson(join(runsDirectory, runId, "approval-pending.json"))
      : undefined
  };
}

async function startIncident(scenario: "hang" | "crac"): Promise<void> {
  output.length = 0;
  processError = undefined;
  processStartedAt = Date.now();
  incidentProcess = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "incident", "--scenario", scenario],
    {
      cwd: process.cwd(),
      env: { ...process.env, HUSH_APPROVAL_MODE: "web" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const capture = (chunk: Buffer) => {
    output.push(...chunk.toString("utf8").split(/\r?\n/u).filter(Boolean));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  incidentProcess.stdout?.on("data", capture);
  incidentProcess.stderr?.on("data", capture);
  incidentProcess.on("exit", (code) => {
    incidentRunning = false;
    if (code && code !== 0)
      processError = `incident process exited with code ${code}`;
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    incidentProcess?.once("spawn", () => {
      incidentRunning = true;
      resolveSpawn();
    });
    incidentProcess?.once("error", (error) => {
      incidentRunning = false;
      incidentProcess = undefined;
      processError = error.message;
      rejectSpawn(error);
    });
  });
}

// The scenario, not just the hardware fault. Posting to the BMC's chaos
// endpoint alone fires the hardware alert and nothing else: no paused kind
// node, and none of the eight Kubernetes and application symptoms `hush-chaos`
// posts to Alertmanager. N0 needs STORM_MIN alerts inside WINDOW_S, so a
// console-triggered run sat in `watch` forever on a two-alert "storm" while the
// same scenario from the CLI ran end to end. The console now runs exactly the
// command the README gives an operator.
const chaosCommand = process.env.HUSH_CHAOS_COMMAND ?? "uv";
const chaosArguments = (process.env.HUSH_CHAOS_ARGS ?? "run,hush-chaos").split(
  ","
);
const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
// `hush-chaos hang` waits out the hardware alert's `for:` window before it
// posts symptoms (I2), so this is tens of seconds, not milliseconds.
const CHAOS_TIMEOUT_MS = 120_000;

async function chaos(...args: string[]): Promise<string> {
  return new Promise<string>((resolveChaos, rejectChaos) => {
    const child = spawn(chaosCommand, [...chaosArguments, ...args], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectChaos(new Error(`hush-chaos ${args.join(" ")} timed out`));
    }, CHAOS_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectChaos(new Error(`could not run ${chaosCommand}: ${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveChaos(stdout);
      else
        rejectChaos(
          new Error(
            `hush-chaos ${args.join(" ")} failed (exit ${code ?? "signal"}): ${(
              stderr || stdout
            )
              .trim()
              .slice(-300)}`
          )
        );
    });
  });
}

async function inject(scenario: "hang" | "crac"): Promise<unknown> {
  // `clear` first, so the button is idempotent: the CLI refuses to pause a kind
  // node that a previous take left paused, and a leftover silence swallows the
  // next storm (I3). This is the "run it between takes" step from the README,
  // done for the operator rather than asked of them.
  await chaos("clear");
  const stdout = await chaos(scenario);
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return { scenario, output: stdout.trim().slice(-500) };
  }
}

async function clearInjectedFault(): Promise<void> {
  try {
    await chaos("clear");
  } catch {
    // Preserve the original spawn error; service status tells the operator if
    // the best-effort rollback could not reach the lab.
  }
}

function validateMutationRequest(
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const origin = request.headers.origin;
  const expectedOrigin = `http://${request.headers.host ?? ""}`;
  if (origin !== expectedOrigin) {
    json(response, 403, { error: "cross-origin requests are not allowed" });
    return false;
  }
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    json(response, 415, { error: "content type must be application/json" });
    return false;
  }
  return true;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`
  );
  if (request.method === "GET" && url.pathname === "/api/status") {
    json(response, 200, await status());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/incidents") {
    if (!validateMutationRequest(request, response)) return;
    const payload = await body(request);
    if (payload.scenario !== "hang" && payload.scenario !== "crac") {
      json(response, 400, { error: "scenario must be hang or crac" });
      return;
    }
    if (incidentStarting || incidentRunning) {
      json(response, 409, { error: "an incident is already running" });
      return;
    }
    incidentStarting = true;
    let injection: unknown;
    try {
      injection = await inject(payload.scenario);
      try {
        await startIncident(payload.scenario);
      } catch (error) {
        await clearInjectedFault();
        throw error;
      }
    } finally {
      incidentStarting = false;
    }
    json(response, 202, { ok: true, scenario: payload.scenario, injection });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/approval") {
    if (!validateMutationRequest(request, response)) return;
    const payload = await body(request);
    const runId = payload.runId;
    if (
      typeof runId !== "string" ||
      !/^inc-\d{8}-[0-9a-fA-F]{4}$/.test(runId) ||
      typeof payload.actionId !== "string" ||
      typeof payload.allow !== "boolean"
    ) {
      json(response, 400, {
        error: "run, actionId, and allow decision are required"
      });
      return;
    }
    const reason =
      typeof payload.reason === "string" ? payload.reason.trim() : undefined;
    if (payload.allow === false && !reason) {
      json(response, 400, { error: "a reason is required to deny an action" });
      return;
    }
    if (reason && reason.length > 300) {
      json(response, 400, { error: "the decision reason is too long" });
      return;
    }
    const pending = (await readJson(
      join(runsDirectory, runId, "approval-pending.json")
    )) as
      | {
          runId?: string;
          action?: { id?: string };
          pending?: {
            toolCallId?: string;
            tool?: string;
            args?: unknown;
          };
        }
      | undefined;
    if (
      pending?.runId !== runId ||
      pending.action?.id !== payload.actionId ||
      typeof payload.toolCallId !== "string" ||
      pending.pending?.toolCallId !== payload.toolCallId
    ) {
      json(response, 409, { error: "this action is no longer pending" });
      return;
    }
    const decisionKey = `${runId}:${payload.actionId}:${payload.toolCallId}`;
    if (recordedDecisions.has(decisionKey)) {
      json(response, 409, { error: "this action already has a decision" });
      return;
    }
    recordedDecisions.add(decisionKey);
    await mkdir(join(runsDirectory, runId), { recursive: true });
    const decisionPath = join(runsDirectory, runId, "approval-decision.json");
    const temporaryPath = `${decisionPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({
          runId,
          actionId: payload.actionId,
          toolCallId: payload.toolCallId,
          tool: pending.pending.tool,
          args: pending.pending.args,
          allow: payload.allow,
          reason
        })}\n`,
        "utf8"
      );
      await rename(temporaryPath, decisionPath);
    } catch (error) {
      recordedDecisions.delete(decisionKey);
      await rm(temporaryPath, { force: true });
      throw error;
    }
    json(response, 202, { ok: true });
    return;
  }
  await serveStatic(url.pathname, response);
}

async function serveStatic(
  pathname: string,
  response: ServerResponse
): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = resolve(publicDirectory, requested);
  const fromPublic = relative(resolve(publicDirectory), path);
  if (fromPublic.startsWith("..") || isAbsolute(fromPublic)) {
    json(response, 404, { error: "not found" });
    return;
  }
  try {
    await access(path);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    response.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream"
    });
    createReadStream(path).pipe(response);
  } catch {
    json(response, 404, { error: "not found" });
  }
}

export const server = createServer((request, response) => {
  route(request, response).catch((error: unknown) => {
    json(response, 500, {
      error: error instanceof Error ? error.message : "unexpected error"
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Hush console ready at http://127.0.0.1:${port}`);
});
