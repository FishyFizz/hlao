import type { ClientCapabilities } from "@agentclientprotocol/sdk";

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
