#!/usr/bin/env node

const path = require("node:path");
const { installSloppydisk, printStatus, uninstallSloppydisk } = require("../lib/patcher");

const TOOL_NAME = "sloppydisk";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const postinstall = args.includes("--postinstall");
  const lifecycle = args.includes("--lifecycle");
  const normalized = command || "help";

  switch (normalized) {
    case "patch":
    case "install":
      await installSloppydisk({ postinstall: postinstall || lifecycle });
      break;
    case "stock":
    case "uninstall":
      await uninstallSloppydisk({ lifecycle });
      break;
    case "status":
      await printStatus();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown ${TOOL_NAME} command: ${normalized}`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp() {
  const invokedAs = path.basename(process.argv[1] || TOOL_NAME);
  console.log(`${invokedAs}

Commands:
  ${invokedAs} patch      Patch the installed Codex runtime in place.
  ${invokedAs} stock      Restore stock Codex behavior.
  ${invokedAs} status     Show patch status.
`);
}

module.exports = { main };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
