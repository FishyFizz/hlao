/**
 * A scriptable ACP v1 agent used by HLAO's tests.
 *
 * It is a real adapter: it speaks the wire protocol through the same SDK the
 * supervisor uses. Behaviour is selected by FAKE_MODE so tests can drive
 * timing, permissions, cancellation, and crashes without a provider account.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  PromptResponse,
  RequestPermissionRequest,
  StopReason,
} from "@agentclientprotocol/sdk";

const mode = process.env.FAKE_MODE ?? "echo";
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 5_000);
const counterFile = process.env.FAKE_COUNTER_FILE;
const doneAt = Number(process.env.FAKE_DONE_AT ?? 2);

let nextSession = 0;
let cancelActive: (() => void) | null = null;
let currentMode = "default";

const availableModes = [
  { id: "default", name: "Manual", description: "Always ask" },
  { id: "auto", name: "Auto", description: "The agent decides" },
  { id: "bypassPermissions", name: "Bypass", description: "Accept all" },
];

const app = agent({ name: "fake-acp" })
  .onRequest("initialize", async ({ params }) => {
    const startupDelay = Number(process.env.FAKE_STARTUP_DELAY_MS ?? 0);
    if (startupDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, startupDelay));
    }
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: {
          close: {},
          list: {},
        },
      },
      agentInfo: { name: "fake-acp", version: "1.0.0" },
    };
  })
  .onRequest("session/new", ({ params }) => {
    nextSession += 1;
    return {
      sessionId: `fake-${nextSession}`,
      modes: {
        currentModeId: currentMode,
        availableModes,
      },
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
  .onRequest("session/list", () => ({ sessions: [] }))
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
      const request: RequestPermissionRequest = {
        sessionId,
        toolCall: {
          toolCallId: "call-1",
          title: "Run the build",
          kind: "execute",
          status: "pending",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      };
      const response = await client.request("session/request_permission", request);
      const outcome = response.outcome;
      if (outcome.outcome === "selected") {
        await message(`permission: ${outcome.optionId}`);
      } else {
        await message("permission: cancelled");
      }
      return { stopReason: "end_turn" };
    }

    if (mode === "slow" || mode === "never") {
      await message("working…");
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
      await message(`stopped: ${stop}`, "m2");
      return { stopReason: stop };
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
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Always", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        })
        .catch(() => {
          // The supervisor cancels the pending request when the turn fails.
        });
      throw new Error("provider failed before the permission was answered");
    }

    if (mode === "spawn-child") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const pidFile = process.env.FAKE_CHILD_PID_FILE;
      if (pidFile) writeFileSync(pidFile, String(child.pid));
      await message(`CHILD_PID: ${child.pid}`);
      const stop = await new Promise<StopReason>((resolve) => {
        cancelActive = () => resolve("cancelled");
      });
      cancelActive = null;
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
        })}`,
      );
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
    });
    await message(`echo: ${text}`);
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-echo",
      status: "completed",
      title: "Read the prompt",
    });
    if (mode === "chunks") {
      await message(" | chunk-2");
      await message(" | chunk-3");
    }
    await send({
      sessionUpdate: "usage_update",
      used: 42,
      size: 200_000,
    });
    return { stopReason: "end_turn" } satisfies PromptResponse;
  });

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
