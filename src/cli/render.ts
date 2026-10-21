// Presentation barrel. Implementations live in ./render/*:
//   style     ANSI styles and status colours
//   text      sanitization, width/truncation, human formatting
//   table     the generic aligned table and width fitting
//   session-table / session-fields   the session table and its cells
//   session   session header, state block, read page, permission/elicitation
//   events    the event-stream renderer
//   entities  backend, provider-session, and doctor tables
export * from "./render/style.js";
export * from "./render/text.js";
export * from "./render/table.js";
export * from "./render/session-fields.js";
export * from "./render/session-table.js";
export * from "./render/session.js";
export * from "./render/entities.js";
export * from "./render/events.js";
