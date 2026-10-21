/**
 * A scriptable ACP v1 agent used by HLAO's tests.
 *
 * It is a real adapter: it speaks the wire protocol through the same SDK the
 * supervisor uses. Behaviour is selected by FAKE_MODE so tests can drive
 * timing, permissions, cancellation, and crashes without a provider account.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  PromptResponse,
  RequestPermissionRequest,
  StopReason,
} from "@agentclientprotocol/sdk";

const mode = process.env.FAKE_MODE ?? "echo";
const steeringEnabled = process.env.FAKE_NO_STEERING !== "1";
const loadEnabled = process.env.FAKE_LOAD_SESSION === "1";
const forkEnabled = process.env.FAKE_FORK_SESSION === "1";
const listEnabled = process.env.FAKE_NO_LIST_SESSION !== "1";
const catalogFile = process.env.FAKE_PROVIDER_CATALOG_FILE;
const externalSessions = process.env.FAKE_PROVIDER_SESSIONS;
const resumeHistory = (process.env.FAKE_RESUME_HISTORY ?? "restored user prompt\nrestored first reply\nrestored second reply").split("\n");
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 5_000);
const counterFile = process.env.FAKE_COUNTER_FILE;
const doneAt = Number(process.env.FAKE_DONE_AT ?? 2);
const optionMode = process.env.FAKE_NO_ALWAYS === "1" ? "basic" : "full";
const permissionCount = Number(process.env.FAKE_PERMISSION_COUNT ?? 2);

let nextSession = 0;
let nextFork = 0;
let cancelActive: (() => void) | null = null;
/** Set while a session/prompt handler is in flight and able to take a steer. */
let steerActive:
  | { sessionId: string; inject: (text: string) => Promise<void> }
  | null = null;
let currentMode = "default";
let promptCount = 0;
let clientCaps: unknown = null;
let configValues: Record<string, string | boolean> = {
  model: "sonnet",
  verbose: false,
};

function configOptions(): Array<Record<string, unknown>> {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      description: "Provider model",
      category: "model",
      currentValue: String(configValues.model),
      options: [
        { value: "sonnet", name: "Sonnet", description: "balanced" },
        { value: "opus", name: "Opus", description: "deep" },
      ],
    },
    {
      type: "boolean",
      id: "verbose",
      name: "Verbose",
      description: "Emit extra diagnostics",
      category: "model_config",
      currentValue: Boolean(configValues.verbose),
    },
  ];
}

type SteerParams = {
  sessionId: string;
  prompt: Array<{ type: string; text?: string }>;
  _meta?: { steering?: { idleBehavior?: string } };
};

interface CatalogRow {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

/**
 * The provider's durable catalog for tests. A file makes the catalog visible
 * across adapter processes: the supervisor's session process and the
 * short-lived provider-list probe are different processes.
 */
function appendCatalog(row: CatalogRow): void {
  if (!catalogFile) return;
  try {
    appendFileSync(catalogFile, `${JSON.stringify(row)}\n`);
  } catch {
    // A missing catalog file is an environment problem, not a session failure.
  }
}

function readCatalog(): CatalogRow[] {
  const rows: CatalogRow[] = [];
  if (catalogFile) {
    try {
      for (const line of readFileSync(catalogFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line) as CatalogRow);
        } catch {
          // Skip a torn line; the writer is append-only.
        }
      }
    } catch {
      // No catalog yet.
    }
  }
  if (externalSessions) {
    try {
      const parsed = JSON.parse(externalSessions) as unknown;
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (row && typeof row === "object") rows.push(row as CatalogRow);
        }
      }
    } catch {
      // Ignore a malformed fixture value.
    }
  }
  return rows;
}

function sameCwd(left: string, right: string): boolean {
  // Model the real adapters' native-path comparison: separators and, on
  // Windows, case do not distinguish two project directories.
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function listCatalog(cwd: string | null): { sessions: CatalogRow[]; nextCursor: null } {
  const byId = new Map<string, CatalogRow>();
  for (const row of readCatalog()) {
    if (typeof row.sessionId !== "string" || typeof row.cwd !== "string") continue;
    if (cwd !== null && !sameCwd(row.cwd, cwd)) continue;
    byId.set(row.sessionId, {
      sessionId: row.sessionId,
      cwd: row.cwd,
      title: typeof row.title === "string" ? row.title : null,
      updatedAt:
        typeof row.updatedAt === "string"
          ? row.updatedAt
          : new Date().toISOString(),
    });
  }
  return { sessions: [...byId.values()], nextCursor: null };
}

const availableModes = [
  { id: "default", name: "Manual", description: "Always ask" },
  { id: "auto", name: "Auto", description: "The agent decides" },
  { id: "bypassPermissions", name: "Bypass", description: "Accept all" },
];

/**
 * The provider's own option set. `always: false` models an adapter that does
 * not offer either always kind, for the no-fallback `bad_option` tests.
 */
function permissionOptions(
  mode: "full" | "basic" = "full",
): { optionId: string; name: string; kind: string }[] {
  if (mode === "basic") {
    return [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ];
  }
  return [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Always", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
    { optionId: "reject-always", name: "Never", kind: "reject_always" },
  ];
}

const app = agent({ name: "fake-acp" })
  .onRequest("initialize", async ({ params }) => {
    if (mode === "crash-start") {
      process.exit(3);
    }
    clientCaps = params.clientCapabilities ?? null;
    const startupDelay = Number(process.env.FAKE_STARTUP_DELAY_MS ?? 0);
    if (startupDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, startupDelay));
    }
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: loadEnabled,
        sessionCapabilities: {
          close: {},
          ...(listEnabled ? { list: {} } : {}),
          ...(loadEnabled ? { resume: {} } : {}),
          ...(forkEnabled ? { fork: {} } : {}),
        },
      },
      agentInfo: { name: "fake-acp", version: "1.0.0" },
      _meta: { steering: { supported: steeringEnabled } },
    };
  })
  .onRequest("session/fork", ({ params }) => {
    if (!forkEnabled) {
      throw new Error("session/fork is not advertised");
    }
    nextFork += 1;
    const sessionId = `${params.sessionId}-fork-${nextFork}`;
    appendCatalog({
      sessionId,
      cwd: params.cwd,
      title: null,
      updatedAt: new Date().toISOString(),
    });
    return {
      sessionId,
      modes: {
        currentModeId: currentMode,
        availableModes,
      },
      configOptions: configOptions() as never,
    };
  })
  .onRequest("session/load", async ({ params, client }) => {
    if (!loadEnabled) {
      throw new Error("loadSession is not advertised");
    }
    if (!params.sessionId.startsWith("fake-")) {
      throw new Error(`unknown session ${params.sessionId}`);
    }
    let index = 0;
    for (const text of resumeHistory) {
      index += 1;
      await client.notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: index === 1 ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text },
          messageId: "restored-history",
        } as never,
      });
    }
    return {
      modes: {
        currentModeId: currentMode,
        availableModes,
      },
      configOptions: configOptions() as never,
    };
  })
  .onRequest("session/new", ({ params }) => {
    nextSession += 1;
    const sessionId = `fake-${nextSession}`;
    appendCatalog({
      sessionId,
      cwd: params.cwd,
      title: null,
      updatedAt: new Date().toISOString(),
    });
    return {
      sessionId,
      modes: {
        currentModeId: currentMode,
        availableModes,
      },
      configOptions:
        process.env.FAKE_NO_CONFIG === "1" ? undefined : (configOptions() as never),
      _meta: { cwd: params.cwd },
    };
  })
  .onRequest("session/set_mode", async ({ params, client }) => {
    currentMode = params.modeId;
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: params.modeId,
      } as never,
    });
    return {};
  })
  .onRequest("session/set_config_option", async ({ params, client }) => {
    configValues = { ...configValues, [params.configId]: params.value };
    const options = configOptions();
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: options,
      } as never,
    });
    return { configOptions: options as never };
  })
  .onRequest("session/list", ({ params }) => {
    if (!listEnabled) {
      throw new Error("session/list is not advertised");
    }
    return listCatalog(
      typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : null,
    );
  })
  .onRequest("session/close", () => ({}))
  .onNotification("session/cancel", () => {
    cancelActive?.();
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const sessionId = params.sessionId;
    const text = params.prompt
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    const send = (update: Record<string, unknown>): Promise<void> =>
      client.notify("session/update", {
        sessionId,
        update: update as never,
      });

    promptCount += 1;
    if (mode === "slow-first" && promptCount > 1) {
      await send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working…" },
        messageId: "m1",
      });
      await send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stopped: end_turn" },
        messageId: "m2",
      });
      return { stopReason: "end_turn" };
    }

    const message = (content: string, messageId = "m1"): Promise<void> =>
      send({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: content },
        messageId,
      });

    if (mode === "crash") {
      setTimeout(() => process.exit(3), 50);
      await new Promise<void>(() => {});
      return { stopReason: "end_turn" };
    }

    if (mode === "permission") {
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Run the build",
        kind: "execute",
        status: "pending",
      });
      steerActive = {
        sessionId,
        inject: (steered) => message(`steered: ${steered}`, "steer-1"),
      };
      const request: RequestPermissionRequest = {
        sessionId,
        toolCall: {
          toolCallId: "call-1",
          title: "Run the build",
          kind: "execute",
          status: "pending",
        },
        options: permissionOptions(optionMode) as never,
      };
      const response = await client.request("session/request_permission", request);
      steerActive = null;
      const outcome = response.outcome;
      if (outcome.outcome === "selected") {
        await message(`permission: ${outcome.optionId}`);
      } else {
        await message("permission: cancelled");
      }
      return { stopReason: "end_turn" };
    }

    if (mode === "permission-multi") {
      // Parallel tool calls each ask independently. The supervisor must queue
      // them, not auto-cancel the second.
      const count = Math.max(1, Math.min(20, permissionCount));
      const withdrawFirst = process.env.FAKE_WITHDRAW_FIRST === "1";
      const withdrawMs = Number(process.env.FAKE_WITHDRAW_MS ?? 500);
      const requests: Promise<{
        outcome: { outcome: string; optionId?: string };
      } | null>[] = [];
      for (let index = 1; index <= count; index += 1) {
        const toolCallId = `call-multi-${index}`;
        const title = `Parallel build ${index}`;
        await send({
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          kind: "execute",
          status: "pending",
        });
        const withdraw = withdrawFirst && index === 1;
        const controller = new AbortController();
        requests.push(
          client
            .request(
              "session/request_permission",
              {
                sessionId,
                toolCall: {
                  toolCallId,
                  title,
                  kind: "execute",
                  status: "pending",
                },
                options: permissionOptions(optionMode) as never,
              },
              withdraw ? { cancellationSignal: controller.signal } : undefined,
            )
            .catch(() => null) as Promise<{
            outcome: { outcome: string; optionId?: string };
          } | null>,
        );
        if (withdraw) setTimeout(() => controller.abort(), withdrawMs);
      }
      const responses = await Promise.all(requests);
      const outcomes = responses.map((response) =>
        response === null
          ? "withdrawn"
          : response.outcome.outcome === "selected"
            ? response.outcome.optionId ?? "selected"
            : "cancelled",
      );
      await message(`permissions: ${outcomes.join(",")}`, "m2");
      return { stopReason: "end_turn" };
    }

    if (mode === "slow" || mode === "never" || mode === "slow-first") {
      await message("working…");
      steerActive = {
        sessionId,
        inject: (steered) => message(`steered: ${steered}`, "steer-1"),
      };
      const stop = await new Promise<StopReason>((resolve) => {
        if (mode === "slow") {
          const timer = setTimeout(() => resolve("end_turn"), delayMs);
          cancelActive = () => {
            clearTimeout(timer);
            resolve("cancelled");
          };
        } else {
          cancelActive = () => resolve("cancelled");
        }
      });
      cancelActive = null;
      steerActive = null;
      await message(`stopped: ${stop}`, "m2");
      return { stopReason: stop };
    }

    if (mode === "elicitation") {
      const caps = clientCaps as
        | { elicitation?: { form?: unknown } }
        | null
        | undefined;
      await message(
        `capability: ${caps?.elicitation?.form !== undefined ? "form" : "none"}`,
      );
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "call-ask",
        title: "Ask the user",
        kind: "ask",
        status: "pending",
      });
      const response = await client.request("elicitation/create", {
        mode: "form",
        sessionId,
        toolCallId: "call-ask",
        message: "Choose a build",
        requestedSchema: {
          type: "object",
          properties: {
            question_0: {
              type: "string",
              title: "Which build?",
              oneOf: [
                { const: "build-a", title: "Build A" },
                { const: "build-b", title: "Build B" },
              ],
            },
            question_1_custom: {
              type: "string",
              title: "Other",
            },
          },
          required: ["question_0"],
        },
      });
      if (response.action === "accept") {
        await message(
          `elicitation: accept ${JSON.stringify(response.content ?? {})}`,
          "m2",
        );
      } else {
        await message(`elicitation: ${response.action}`, "m2");
      }
      return { stopReason: "end_turn" };
    }

    if (mode === "elicitation-withdrawn") {
      const controller = new AbortController();
      const response = client
        .request(
          "elicitation/create",
          {
            mode: "form",
            sessionId,
            message: "A question nobody will answer",
            requestedSchema: {
              type: "object",
              properties: { question_0: { type: "string", title: "Anything" } },
            },
          },
          { cancellationSignal: controller.signal },
        )
        .catch(() => null);
      setTimeout(() => controller.abort(), 500);
      const settled = await response;
      await message(
        settled?.action === "accept"
          ? "elicitation: accept"
          : "elicitation: withdrawn",
        "m2",
      );
      return { stopReason: "end_turn" };
    }

    if (mode === "permission-after-turn") {
      // Model work that outlives the prompt: an autonomous cycle (a
      // background-task notification, a peer message) still runs tool calls
      // that need permission after the prompt's result is delivered.
      await message("turn done");
      setTimeout(() => {
        void (async () => {
          await send({
            sessionUpdate: "tool_call",
            toolCallId: "call-late",
            title: "Run the late build",
            kind: "execute",
            status: "pending",
          });
          const response = await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "call-late",
              title: "Run the late build",
              kind: "execute",
              status: "pending",
            },
            options: permissionOptions(optionMode) as never,
          });
          const outcome = response.outcome;
          await message(
            outcome.outcome === "selected"
              ? `late permission: ${outcome.optionId}`
              : "late permission: cancelled",
            "m2",
          );
        })();
      }, 60);
      return { stopReason: "end_turn" };
    }

    if (mode === "permission-withdrawn") {
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "call-withdrawn",
        title: "Run the withdrawn build",
        kind: "execute",
        status: "pending",
      });
      const controller = new AbortController();
      const response = client
        .request(
          "session/request_permission",
          {
            sessionId,
            toolCall: {
              toolCallId: "call-withdrawn",
              title: "Run the withdrawn build",
              kind: "execute",
              status: "pending",
            },
            options: permissionOptions(optionMode) as never,
          },
          { cancellationSignal: controller.signal },
        )
        .catch(() => null);
      setTimeout(() => controller.abort(), 500);
      const settled = await response;
      await message(
        settled?.outcome.outcome === "selected"
          ? `permission: ${settled.outcome.optionId}`
          : "permission: withdrawn",
        "m2",
      );
      return { stopReason: "end_turn" };
    }

    if (mode === "permission-then-fail") {
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "call-fail",
        title: "Doomed call",
        kind: "execute",
        status: "pending",
      });
      void client
        .request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "call-fail",
            title: "Doomed call",
            kind: "execute",
            status: "pending",
          },
          options: permissionOptions(optionMode) as never,
        })
        .catch(() => {
          // The supervisor cancels the pending request when the turn fails.
        });
      throw new Error("provider failed before the permission was answered");
    }

    if (mode === "signal") {
      await send({
        sessionUpdate: "session_info_update",
        title: "Provider Session",
        updatedAt: new Date().toISOString(),
      });
      await send({
        sessionUpdate: "plan",
        entries: [
          { content: "inspect", priority: "high", status: "completed" },
          { content: "implement", priority: "high", status: "in_progress" },
          { content: "verify", priority: "medium", status: "pending" },
        ],
      });
      await send({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "plan-1",
          entries: [
            { content: "inspect", priority: "high", status: "completed" },
            { content: "implement", priority: "high", status: "completed" },
            { content: "verify", priority: "medium", status: "in_progress" },
          ],
        },
      });
      const planForm = process.env.FAKE_SIGNAL_PLAN;
      if (planForm === "file") {
        await send({
          sessionUpdate: "plan_update",
          plan: { type: "file", planId: "plan-file", uri: "file:///plan.md" },
        });
      } else if (planForm === "markdown") {
        await send({
          sessionUpdate: "plan_update",
          plan: {
            type: "markdown",
            planId: "plan-md",
            content: "# markdown plan\n\n1. one\n2. two",
          },
        });
      } else if (planForm === "remove") {
        await send({ sessionUpdate: "plan_removed", planId: "plan-1" });
      }
      await send({
        sessionUpdate: "compaction_update",
        compactionId: "cmp-1",
        status: "in_progress",
      });
      await send({
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "cmp-1",
        content: { type: "text", text: "Summary of earlier work" },
      });
      await send({
        sessionUpdate: "compaction_update",
        compactionId: "cmp-1",
        status: "completed",
      });
      await send({
        sessionUpdate: "session_message",
        messageId: "sms-1",
        senderSessionId: "sibling",
        recipientSessionId: "self",
        content: [{ type: "text", text: "provider message" }],
      });
      await send({
        sessionUpdate: "session_message_chunk",
        messageId: "sms-2",
        senderSessionId: "sibling",
        recipientSessionId: "self",
        content: { type: "text", text: "streamed provider message" },
      });
      await send({
        sessionUpdate: "user_message_chunk",
        messageId: "usr-1",
        content: { type: "text", text: "provider user line" },
      });
      await send({ sessionUpdate: "usage_update", used: 150_000, size: 200_000 });
      await send({ sessionUpdate: "usage_update", used: 185_000, size: 200_000 });
      // Drop below the reset threshold and cross 75% again: the warning is
      // re-armed rather than staying latched.
      await send({ sessionUpdate: "usage_update", used: 100_000, size: 200_000 });
      await send({ sessionUpdate: "usage_update", used: 160_000, size: 200_000 });
      await message(`caps: ${JSON.stringify(clientCaps)}`);
      return { stopReason: "end_turn" };
    }

    if (mode === "spawn-child") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const pidFile = process.env.FAKE_CHILD_PID_FILE;
      if (pidFile) writeFileSync(pidFile, String(child.pid));
      await message(`CHILD_PID: ${child.pid}`);
      steerActive = {
        sessionId,
        inject: (steered) => message(`steered: ${steered}`, "steer-1"),
      };
      const stop = await new Promise<StopReason>((resolve) => {
        cancelActive = () => resolve("cancelled");
      });
      cancelActive = null;
      steerActive = null;
      return { stopReason: stop };
    }

    if (mode === "env") {
      await message(
        `ENV ${JSON.stringify({
          sessionId: process.env.HLAO_SESSION_ID ?? null,
          name: process.env.HLAO_NAME ?? null,
          parentId: process.env.HLAO_PARENT_ID ?? null,
          rootId: process.env.HLAO_ROOT_ID ?? null,
          depth: process.env.HLAO_DEPTH ?? null,
          backend: process.env.HLAO_BACKEND ?? null,
          home: process.env.HLAO_HOME ?? null,
          cli: process.env.HLAO_CLI ?? null,
          skill: process.env.HLAO_SKILL ?? null,
          skillVersion: process.env.HLAO_SKILL_VERSION ?? null,
        })}`,
      );
      return { stopReason: "end_turn" };
    }

    if (mode === "delayed-crash") {
      await message("about to fail", "m1");
      setTimeout(() => process.exit(4), delayMs);
      await new Promise<void>(() => {});
      return { stopReason: "end_turn" };
    }

    if (mode === "messages") {
      await message("first message", "m1");
      await message("second message", "m2");
      return { stopReason: "end_turn" };
    }

    if (mode === "ansi") {
      await message("\u001b[31mred text\u001b[0m and \u001b[2Jclear", "m1");
      return { stopReason: "end_turn" };
    }

    if (mode === "verdict") {
      await message(`VERDICT: ${process.env.FAKE_VERDICT ?? "possible"}`);
      return { stopReason: "end_turn" };
    }

    if (mode === "counter") {
      if (!counterFile) {
        await message("FAKE_COUNTER_FILE is missing");
        return { stopReason: "end_turn" };
      }
      let count = 0;
      try {
        count = (JSON.parse(readFileSync(counterFile, "utf8")) as { count?: number }).count ?? 0;
      } catch {
        count = 0;
      }
      count += 1;
      writeFileSync(counterFile, JSON.stringify({ count }));
      await message(count >= doneAt ? "STATUS: DONE" : `STATUS: RUNNING count=${count}`);
      return { stopReason: "end_turn" };
    }

    if (mode === "flood") {
      const count = Number(process.env.FAKE_CHUNKS ?? 150);
      for (let index = 0; index < count; index += 1) {
        await send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `chunk-${index} ` },
          messageId: `flood-${Math.floor(index / 10)}`,
        });
      }
      return { stopReason: "end_turn" };
    }

    // echo / chunks
    await send({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "considering the prompt" },
      messageId: "thought-1",
    });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "call-echo",
      title: "Read the prompt",
      kind: "read",
      status: "in_progress",
      rawInput: { prompt: text },
    });
    await message(`echo: ${text}`);
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-echo",
      status: "completed",
      title: "Read the prompt",
      rawInput: { command: "echo prompt" },
      rawOutput: { ok: true },
    });
    if (mode === "chunks") {
      await message(" | chunk-2");
      await message(" | chunk-3");
    }
    if (mode === "usage") {
      await send({
        sessionUpdate: "usage_update",
        used: 1_200,
        size: 200_000,
        cost: { amount: 125, currency: "USD" },
      });
      await send({
        sessionUpdate: "usage_update",
        used: 1_450,
        size: 200_000,
        cost: { amount: 250, currency: "USD" },
      });
    }
    if (mode !== "usage") {
      await send({
        sessionUpdate: "usage_update",
        used: 42,
        size: 200_000,
      });
    }
    return { stopReason: "end_turn" } satisfies PromptResponse;
  });

if (steeringEnabled) {
  app.onRequest(
    "_session/steering",
    (raw: unknown) => raw as SteerParams,
    async ({ params }) => {
      const text = params.prompt
        .map((block) => (block.type === "text" ? block.text ?? "" : ""))
        .join("");
      if (steerActive === null || steerActive.sessionId !== params.sessionId) {
        // The Host opts into this so an idle race does not start a turn the
        // Host cannot settle.
        if (params._meta?.steering?.idleBehavior === "promptRequired") {
          return { outcome: "promptRequired", reason: "noRunningTurn" };
        }
        return { outcome: "startedNewTurn" };
      }
      await steerActive.inject(text);
      return { outcome: "injected" };
    },
  );
}

const connection = app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);

process.stdin.on("close", () => {
  connection.close();
  process.exit(0);
});
process.stdin.on("end", () => {
  connection.close();
  process.exit(0);
});
