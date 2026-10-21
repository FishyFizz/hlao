/**
 * The ACP steering extension advertises itself in `InitializeResponse._meta`:
 * `{ steering: { supported: true } }`. Anything else means queue-only.
 */
export function steeringSupported(meta: unknown): boolean {
  if (meta === null || typeof meta !== "object") return false;
  const steering = (meta as { steering?: unknown }).steering;
  if (steering === null || typeof steering !== "object") return false;
  return (steering as { supported?: unknown }).supported === true;
}
