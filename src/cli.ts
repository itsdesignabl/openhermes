#!/usr/bin/env node
// node:sqlite prints an "experimental" warning on load; hide only that one.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: any, ...rest: any[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (typeof text === "string" && text.includes("SQLite is an experimental feature")) return;
  return (emitWarning as any)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import("./main.js");
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`Error: ${err?.message ?? err}`);
    process.exitCode = 1;
  },
);
