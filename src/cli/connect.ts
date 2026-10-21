import { connectSupervisor, type SupervisorConnection } from "../client.js";
import { HlaoError } from "../errors.js";
import type { HelloResult, ProtocolCapability } from "../protocol.js";
import type { CommandContext } from "./context.js";

export async function connect(
  ctx: CommandContext,
  autostart = true,
): Promise<SupervisorConnection> {
  const conn = await connectSupervisor({
    home: ctx.home,
    cliPath: ctx.cliPath,
    callerSessionId: ctx.callerSessionId,
    autostart,
  });
  if (conn.started === true) {
    try {
      const hello = await conn.request<HelloResult>("hello", {});
      if (hello.lastCrash) {
        process.stderr.write(
          `hlao: previous supervisor (pid ${hello.lastCrash.pid}) did not shut down cleanly; its live table and retained history were lost\n`,
        );
      }
    } catch {
      // The command's own request reports a real connection failure.
    }
  }
  return conn;
}

let capabilityCache: {
  endpoint: string;
  capabilities: Set<string>;
} | null = null;

/**
 * Feature-detect an additive wire capability. A new CLI may meet a supervisor
 * started before an upgrade; the protocol requires major equality, so the
 * command is refused with a clear restart hint rather than an unknown-field
 * error from an older parser.
 */
async function capabilitySet(
  conn: SupervisorConnection,
): Promise<Set<string>> {
  if (capabilityCache === null || capabilityCache.endpoint !== conn.lock.endpoint) {
    const hello = await conn.request<HelloResult>("hello", {});
    capabilityCache = {
      endpoint: conn.lock.endpoint,
      capabilities: new Set(
        Array.isArray(hello.capabilities) ? hello.capabilities : [],
      ),
    };
  }
  return capabilityCache.capabilities;
}

/**
 * Like `ensureCapability`, but for optional behavior: an older supervisor
 * simply yields false so the caller can omit the new field.
 */
export async function hasCapability(
  conn: SupervisorConnection,
  capability: ProtocolCapability,
): Promise<boolean> {
  return (await capabilitySet(conn)).has(capability);
}

export async function ensureCapability(
  conn: SupervisorConnection,
  capability: ProtocolCapability,
  command: string,
): Promise<void> {
  if (!(await capabilitySet(conn)).has(capability)) {
    throw new HlaoError(
      "version_mismatch",
      `${command} needs the "${capability}" protocol capability; the running supervisor predates it. Restart it with "hlao down" and retry.`,
    );
  }
}
