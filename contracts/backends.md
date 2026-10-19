# Contract — `backends` / `config`

A backend is a **data manifest**, never a class. Adding an agent must not require code.

```ts
type BackendManifest = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  description?: string;
  source: "builtin" | "user" | "project";
  available: boolean;
  unavailableReason?: string;
};
```

## Built-ins

| Name | Launch | Notes |
|---|---|---|
| `claude` | `node <resolved @agentclientprotocol/claude-agent-acp>/dist/index.js` | Requires the adapter's own provider auth to be present |
| `codex` | `node <resolved @agentclientprotocol/codex-acp>` | Requires the adapter's own provider auth to be present |

Resolution uses `createRequire(import.meta.url)` against HLAO's own dependencies, so a
locally installed or globally installed HLAO resolves the pinned adapters it shipped with.
Resolution failure yields `available: false` with the resolver's message; the entry still
appears in `hlao agents` so the failure is visible rather than silent.

## User config — `<HLAO_HOME>/config.json`

```jsonc
{
  "permissionPolicy": "allow",      // allow | ask | deny
  "waitTimeoutMs": 1800000,
  "sendWaitTimeoutMs": 1800000,
  "startupTimeoutMs": 120000,
  "maxEventsPerSession": 5000,
  "maxEventLogBytes": 16777216,
  "maxEventBytes": 262144,
  "retainClosedMs": 3600000,
  "backends": {
    "my-agent": {
      "command": "my-agent",
      "args": ["acp"],
      "env": { "MY_FLAG": "1" },
      "description": "optional"
    }
  }
}
```

All fields are optional. Unknown top-level keys are rejected so a typo cannot silently do
nothing. Duration fields are milliseconds.

## Project config — `<cwd>/.hlao/agents.json`

```json
{
  "backends": {
    "repo-agent": { "command": "node", "args": ["tools/acp-agent.js"] }
  }
}
```

Only `backends` is accepted in project scope. It exists because a backend often belongs to
the repository being worked on; it is read at `spawn`/`agents.list` time for the requested
`cwd`, never cached across directories.

## Merge order (later wins)

1. built-ins
2. user config `backends`
3. project config `backends`

A later definition replaces the earlier one entirely; there is no partial merge. `source`
reports where the winner came from. Env maps merge shallowly within the winning definition
only.

## Validation at the boundary

- `command`: non-empty string. A bare command is resolved against PATH, and an absolute
  path against the filesystem; either can set `available: false` with a reason rather than a
  false READY. A relative path is resolved by the OS at spawn time against the session cwd,
  so it is not pre-judged here.
- `args`: array of strings.
- `env`: object whose values are strings.
- Unknown backend keys are rejected.
- All fields of user config are validated before any is applied; an invalid file applies
  none of its values. The supervisor still starts, but `agents.list` and `sessions.spawn`
  fail with `config_invalid`, and `doctor` reports the file and reason. This keeps a typo
  from silently changing `permissionPolicy` or a timeout.
- Invalid project config fails only that `spawn`/`agents.list` request with
  `config_invalid`, naming the file.

## What config is not

Configuration may select a backend and bound waits. It may not:
- define a schedule, workflow, dependency graph, or recurring task;
- define a shared state store;
- declare lineage or visibility beyond the injected `HLAO_*` identity;
- change read semantics.
