import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const files = [];
for (const directory of ["test", "tests"]) {
  for (const name of await readdir(directory)) {
    if (name.endsWith(".test.js")) files.push(path.join(directory, name));
  }
}
files.sort();
const forwarded = process.argv.slice(2);

// npm appends `npm test -- <args>` after this script. Rebuild the Node test
// command so Node's test options appear before file globs on every platform.
const nodeOptions = ["--test", "--test-concurrency=1"];
const positional = [];
for (const argument of forwarded) {
  if (argument.startsWith("--")) nodeOptions.push(argument);
  else positional.push(argument);
}

const child = spawn(process.execPath, [...nodeOptions, ...files, ...positional], {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Test runner failed: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner interrupted by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
