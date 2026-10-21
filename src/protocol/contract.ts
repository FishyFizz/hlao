// The wire contract, split by surface. `views.ts` is what a session presents;
// `methods.ts` is how a client asks for it. This barrel keeps `protocol.js`
// and existing imports stable.
export * from "./views.js";
export * from "./methods.js";
