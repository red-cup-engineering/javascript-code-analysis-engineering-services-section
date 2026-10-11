#!/usr/bin/env node
// cli.mts — javascript-computer introspect <dir-of-dts>
//
// Projects a directory of authored source and declarations into a TypeCatalog and prints it as JSON.

import process from "node:process";
import { realpathSync } from "node:fs";
import { introspectDirectory } from "./introspect.mjs";

function main(argv) {
  const [command, target] = argv;
  if (command !== "introspect" || !target) {
    process.stderr.write("usage: javascript-computer introspect <dir-of-dts>\n");
    process.exitCode = 2;
    return;
  }
  const catalog = introspectDirectory(target);
  process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
}

function isMain() {
  return process.argv[1] !== undefined &&
    new URL(import.meta.url).pathname === realpathSync(process.argv[1]);
}

if (isMain()) main(process.argv.slice(2));
