import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { HlaoError } from "./errors.js";
import { ACP_PROTOCOL_VERSION } from "./protocol/version.js";
import { VERSION } from "./version.js";

/**
 * The client capabilities HLAO advertises to an adapter. Shared by a real
 * session and by the read-only provider-catalog probe so both negotiate the
 * same adapter behavior.
 *
 * Deliberately absent: `fs`, `terminal`, and `subagents`. The leaf remains the
 * leaf; provider subagent sessions are not surfaced.
 */
export const HLAO_CLIENT_CAPABILITIES: ClientCapabilities = {
  session: {
    // Boolean config options are optional in ACP; advertising support lets an
    // adapter include them and accept boolean set requests.
    configOptions: { boolean: {} },
    // Provider-native context state. A compliant adapter only sends compaction
    // updates and live notices when these are advertised.
    compaction: {},
    notices: {},
  },
  // Experimental plan deltas/removals. Full plan replacements remain valid for
  // an adapter that does not opt into the experimental form.
  plan: {},
  // Form elicitation. URL mode is deliberately not advertised: HLAO has no URL
  // surface, and the adapter then declines URL requests instead of leaving
  // them unanswerable.
  elicitation: { form: {} },
};

/** The `initialize` params every HLAO adapter connection sends. */
export function initializeParams(): {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo: { name: string; version: string };
} {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: HLAO_CLIENT_CAPABILITIES,
    clientInfo: { name: "hlao", version: VERSION },
  };
}

/** HLAO speaks one ACP major; a mismatch is a spawn failure with both sides. */
export function assertAcpVersion(backend: string, protocolVersion: number): void {
  if (protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new HlaoError(
      "spawn_failed",
      `${backend} speaks ACP v${protocolVersion}; HLAO requires v${ACP_PROTOCOL_VERSION}`,
    );
  }
}
