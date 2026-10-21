/**
 * ACP adapters expose their permission mode twice: as `modes` (the native
 * surface behind `session/set_mode`) and, in the bundled Claude and Codex
 * adapters, as a select config option. Setting that config option is a mode
 * change, so it must follow the same operator-only rule as `mode` and
 * `spawn --mode`.
 */

/** The config-option id both bundled adapters use for their mode selector. */
export const MODE_CONFIG_ID = "mode";

/**
 * True when `option` is the provider's permission-mode selector. The category
 * is the general rule; the id covers an adapter that omits the category.
 */
export function isModeConfigOption(option: {
  id: string;
  category?: string;
}): boolean {
  return option.category === "mode" || option.id === MODE_CONFIG_ID;
}
