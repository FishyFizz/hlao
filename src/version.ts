import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Single source of truth: package.json next to the compiled dist directory. */
export const VERSION: string = (() => {
  try {
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
