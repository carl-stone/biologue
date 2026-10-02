import { Diagnostics, observeProcessFailures } from "../../src/diagnostics.ts";

const diagnostics = new Diagnostics(process.argv[2]);
observeProcessFailures(diagnostics);
setImmediate(() => {
  const error = new Error("Fatal test failure");
  if (process.argv[3] === "rejection") void Promise.reject(error);
  else throw error;
});
