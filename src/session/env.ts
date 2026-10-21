export interface SessionEnvInput {
  id: string;
  rootId: string;
  depth: number;
  backend: string;
  home: string;
  cliPath: string;
  skillPath: string;
  skillVersion: string;
  name: string | null;
  parentId: string | null;
  /** The backend manifest's configured environment. */
  backendEnv: Record<string, string>;
  /** The spawn request's environment. */
  env: Record<string, string>;
}

/**
 * The child's environment. HLAO identity must exist before the adapter starts,
 * so every leaf tool it runs can see it. A caller's own HLAO_* variables are
 * stripped first: a nested spawn must not inherit its parent's identity.
 */
export function buildSessionEnv(input: SessionEnvInput): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("HLAO_")) base[key] = value;
  }
  return {
    ...base,
    ...input.backendEnv,
    ...input.env,
    HLAO_SESSION_ID: input.id,
    HLAO_ROOT_ID: input.rootId,
    HLAO_DEPTH: String(input.depth),
    HLAO_BACKEND: input.backend,
    HLAO_HOME: input.home,
    HLAO_CLI: input.cliPath,
    HLAO_SKILL: input.skillPath,
    HLAO_SKILL_VERSION: input.skillVersion,
    ...(input.name ? { HLAO_NAME: input.name } : {}),
    ...(input.parentId ? { HLAO_PARENT_ID: input.parentId } : {}),
  };
}
