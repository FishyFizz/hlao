// Wire protocol barrel. Types and constants live in version/contract; boundary
// validation lives in parse. Submodules never import this barrel.
export * from "./protocol/version.js";
export * from "./protocol/contract.js";
export * from "./protocol/parse.js";
