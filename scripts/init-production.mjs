#!/usr/bin/env node

import { bootstrapProduction } from "../src/workflows/production-bootstrap.mjs";

const VALUE_OPTIONS = new Set([
  "client-id",
  "client-name",
  "video-number",
  "mode",
  "title",
  "legacy-project-root",
  "workspace-root",
]);
const FLAG_OPTIONS = new Set(["next", "help"]);

function usage() {
  process.stdout.write(`Internal production bootstrap

Usage:
  node scripts/init-production.mjs --client-id <id> [--client-name <name>]
    (--video-number <N> | --next) [--mode ensure|new|resume]
    [--title <title>] [--legacy-project-root <relative-path>]
    [--workspace-root <path>]
`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || token.length === 2) {
      throw new TypeError(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!VALUE_OPTIONS.has(name) && !FLAG_OPTIONS.has(name)) {
      throw new TypeError(`Unknown option: --${name}`);
    }
    if (Object.hasOwn(options, name)) throw new TypeError(`Duplicate option: --${name}`);
    if (FLAG_OPTIONS.has(name)) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        throw new TypeError(`--${name} does not accept a value`);
      }
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options["client-id"]) throw new TypeError("--client-id is required");
  const hasVideoNumber = Object.hasOwn(options, "video-number");
  const hasNext = options.next === true;
  if (hasVideoNumber === hasNext) {
    throw new TypeError("Provide exactly one of --video-number and --next");
  }

  const context = await bootstrapProduction({
    clientId: options["client-id"],
    ...(options["client-name"] === undefined ? {} : { clientName: options["client-name"] }),
    ...(hasVideoNumber ? { videoNumber: options["video-number"] } : { next: true }),
    mode: options.mode ?? "ensure",
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options["legacy-project-root"] === undefined
      ? {}
      : { legacyProjectRoot: options["legacy-project-root"] }),
    ...(options["workspace-root"] === undefined
      ? {}
      : { workspaceRoot: options["workspace-root"] }),
  });
  process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.name ?? "Error"}: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
