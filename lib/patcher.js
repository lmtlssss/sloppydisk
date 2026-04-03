const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PACKAGE_JSON = require(path.join(PACKAGE_ROOT, "package.json"));
const SLOPPYDISK_HOME = path.join(os.homedir(), ".sloppydisk");
const BACKUP_ROOT = path.join(SLOPPYDISK_HOME, "backups");
const ARTIFACT_ROOT = path.join(SLOPPYDISK_HOME, "artifacts");
const INSTALL_STATE_PATH = path.join(SLOPPYDISK_HOME, "install-state.json");
const CHILD_ENV = createChildEnv();
const ENTRYPOINT_BACKUP_BASENAME = "sloppydisk.codex.original.js";
const PATCH_ARCHIVE_BASENAME = "codex.patch.zst";
const PATCH_MANIFEST_BASENAME = "manifest.json";

const SUPPORTED_CODEX_VERSIONS = ["0.118.0"];

async function installSloppydisk({ postinstall = false } = {}) {
  ensureDir(SLOPPYDISK_HOME);

  let codexInstall = resolveCodexInstall();
  if (!codexInstall) {
    return handleLifecycleError(
      postinstall,
      "Codex is not installed globally. Install it first with: npm install -g @openai/codex"
    );
  }

  try {
    assertSupportedCodexVersion(codexInstall.version);
  } catch (error) {
    return handleLifecycleError(postinstall, error.message);
  }

  const bundle = resolvePatchBundle(codexInstall.version);
  if (!bundle) {
    return handleLifecycleError(
      postinstall,
      `No sloppydisk patch bundle found for Codex ${codexInstall.version} on ${artifactPlatformKey()}. Build one with \`npm run build-release-artifact\` or provide ${PATCH_ARCHIVE_BASENAME} and ${PATCH_MANIFEST_BASENAME} in ${path.join(ARTIFACT_ROOT, codexInstall.version, artifactPlatformKey())}.`
    );
  }

  try {
    validatePatchBundle(codexInstall, bundle);
  } catch (error) {
    return handleLifecycleError(postinstall, error.message);
  }

  if (process.platform === "linux") {
    try {
      ensureCommand(
        "bwrap",
        ["--version"],
        "Install bubblewrap before patching Codex on Linux. This sloppydisk build relies on system bwrap instead of a vendored fallback."
      );
    } catch (error) {
      return handleLifecycleError(postinstall, error.message);
    }
  }

  ensureDir(BACKUP_ROOT);
  const backupBinary = path.join(BACKUP_ROOT, `codex-${codexInstall.version}.original`);
  let currentHash = sha256File(codexInstall.vendorBinary);
  let backupHash = fs.existsSync(backupBinary) ? sha256File(backupBinary) : null;
  let hasValidBackup = backupHash === bundle.manifest.officialSha256;

  if (currentHash === bundle.manifest.patchedSha256 && !hasValidBackup) {
    reinstallOfficialCodex(codexInstall.version);
    codexInstall = resolveCodexInstall();
    if (!codexInstall) {
      return handleLifecycleError(
        postinstall,
        "Codex disappeared while attempting to recover the stock binary."
      );
    }
    currentHash = sha256File(codexInstall.vendorBinary);
  }

  if (currentHash === bundle.manifest.officialSha256) {
    fs.copyFileSync(codexInstall.vendorBinary, backupBinary);
    fs.chmodSync(backupBinary, 0o755);
    backupHash = sha256File(backupBinary);
    hasValidBackup = backupHash === bundle.manifest.officialSha256;
  }

  if (!hasValidBackup) {
    return handleLifecycleError(
      postinstall,
      `Codex vendor binary is in an unknown state and no stock backup is available at ${backupBinary}. Restore stock Codex first with \`npm install -g @openai/codex@${codexInstall.version}\`.`
    );
  }

  const entrypointBackup = ensureEntrypointWrapper(codexInstall);

  if (currentHash !== bundle.manifest.patchedSha256) {
    try {
      ensureCommand(
        "zstd",
        ["--version"],
        "Install zstd before patching Codex so sloppydisk can apply its binary delta."
      );
    } catch (error) {
      return handleLifecycleError(postinstall, error.message);
    }

    const patchedTemp = `${codexInstall.vendorBinary}.sloppydisk.tmp`;
    applyBinaryPatch(backupBinary, bundle.patchPath, patchedTemp);
    const patchedHash = sha256File(patchedTemp);
    if (patchedHash !== bundle.manifest.patchedSha256) {
      fs.rmSync(patchedTemp, { force: true });
      return handleLifecycleError(
        postinstall,
        `Patched Codex hash mismatch. Expected ${bundle.manifest.patchedSha256} but produced ${patchedHash}.`
      );
    }
    replaceBinaryAtomically(patchedTemp, codexInstall.vendorBinary);
    fs.rmSync(patchedTemp, { force: true });
    currentHash = sha256File(codexInstall.vendorBinary);
  }

  const state = {
    installedAt: new Date().toISOString(),
    version: PACKAGE_JSON.version,
    codexVersion: codexInstall.version,
    vendorBinary: codexInstall.vendorBinary,
    backupBinary,
    entrypointPath: codexInstall.entrypointPath,
    entrypointBackup,
    patchPath: bundle.patchPath,
    manifestPath: bundle.manifestPath,
    bundleSource: bundle.source,
    officialSha256: bundle.manifest.officialSha256,
    patchedSha256: bundle.manifest.patchedSha256,
    binarySha256: currentHash,
  };
  fs.writeFileSync(INSTALL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

  console.log(`sloppydisk patched Codex ${codexInstall.version}`);
  console.log(`patched binary: ${codexInstall.vendorBinary}`);
  console.log(`bundle source: ${bundle.source}`);
}

async function printStatus() {
  const codexInstall = resolveCodexInstall();
  if (!codexInstall) {
    console.log("Codex is not installed globally.");
    return;
  }

  const state = readInstallState();
  const bundle = resolvePatchBundle(codexInstall.version);
  const currentHash = sha256File(codexInstall.vendorBinary);

  console.log(`codex version: ${codexInstall.version}`);
  console.log(`codex dir: ${codexInstall.codexDir}`);
  console.log(`supported by sloppydisk: ${SUPPORTED_CODEX_VERSIONS.includes(codexInstall.version)}`);
  console.log(`patch bundle available: ${bundle ? "yes" : "no"}`);
  if (bundle) {
    console.log(`bundle source: ${bundle.source}`);
    console.log(`stock hash matches manifest: ${currentHash === bundle.manifest.officialSha256}`);
    console.log(`patched hash matches manifest: ${currentHash === bundle.manifest.patchedSha256}`);
  }

  const inferredState = state || inferInstallState(codexInstall, bundle, currentHash);
  if (!inferredState) {
    console.log("sloppydisk install state: not found");
    return;
  }

  console.log(`sloppydisk version: ${inferredState.version || PACKAGE_JSON.version}`);
  console.log(`backup binary: ${inferredState.backupBinary}`);
  console.log(`backup present: ${fs.existsSync(inferredState.backupBinary)}`);
  console.log(`entrypoint path: ${inferredState.entrypointPath}`);
  console.log(`entrypoint backup present: ${fs.existsSync(inferredState.entrypointBackup)}`);
  console.log(`install state source: ${state ? "state file" : "inferred from manifest/hash"}`);
}

async function uninstallSloppydisk({ lifecycle = false } = {}) {
  const codexInstall = resolveCodexInstall();
  if (!codexInstall) {
    cleanupInstallState();
    return handleLifecycleError(lifecycle, "Codex is not installed globally. Nothing to restore.");
  }

  const state = readInstallState() || inferInstallState(codexInstall);
  if (!state) {
    cleanupInstallState();
    return handleLifecycleError(lifecycle, "No sloppydisk patch state was found.");
  }

  if (fs.existsSync(state.backupBinary)) {
    replaceBinaryAtomically(state.backupBinary, state.vendorBinary);
    console.log(`Restored original Codex binary from ${state.backupBinary}`);
  } else {
    console.warn(`Backup not found at ${state.backupBinary}. Reinstalling @openai/codex@${state.codexVersion}...`);
    reinstallOfficialCodex(state.codexVersion);
  }

  restoreEntrypoint(state.entrypointPath, state.entrypointBackup);
  cleanupInstallState();
}

function resolveCodexInstall() {
  try {
    const npmRoot = runChecked("npm", ["root", "-g"]).stdout.trim();
    const codexDir = path.join(npmRoot, "@openai", "codex");
    if (!fs.existsSync(codexDir)) {
      return null;
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(codexDir, "package.json"), "utf8"));
    const vendorBinary = findVendorBinary(codexDir);
    if (!vendorBinary) {
      throw new Error("Could not locate Codex vendor binary.");
    }
    const binField = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.codex;
    if (!binField) {
      throw new Error("Could not locate Codex CLI entrypoint.");
    }
    const entrypointPath = path.join(codexDir, binField);

    return { codexDir, version: packageJson.version, vendorBinary, entrypointPath };
  } catch {
    return null;
  }
}

function resolvePatchBundle(version) {
  const envPatch = process.env.SLOPPYDISK_PATCH;
  const envManifest = process.env.SLOPPYDISK_PATCH_MANIFEST;
  const explicit = envPatch && envManifest
    ? [{
        patchPath: envPatch,
        manifestPath: envManifest,
        source: "env",
      }]
    : [];

  const roots = [
    path.join(PACKAGE_ROOT, "artifacts", version, artifactPlatformKey()),
    path.join(ARTIFACT_ROOT, version, artifactPlatformKey()),
  ];
  const candidates = [
    ...explicit,
    ...roots.map((root) => ({
      patchPath: path.join(root, PATCH_ARCHIVE_BASENAME),
      manifestPath: path.join(root, PATCH_MANIFEST_BASENAME),
      source: root.startsWith(PACKAGE_ROOT) ? "packaged" : "cache",
    })),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.patchPath) || !fs.existsSync(candidate.manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(candidate.manifestPath, "utf8"));
    return {
      ...candidate,
      manifest,
    };
  }

  return null;
}

function inferInstallState(codexInstall, bundle = resolvePatchBundle(codexInstall.version), currentHash = sha256File(codexInstall.vendorBinary)) {
  if (!bundle || currentHash !== bundle.manifest.patchedSha256) {
    return null;
  }

  return {
    version: PACKAGE_JSON.version,
    codexVersion: codexInstall.version,
    vendorBinary: codexInstall.vendorBinary,
    backupBinary: path.join(BACKUP_ROOT, `codex-${codexInstall.version}.original`),
    entrypointPath: codexInstall.entrypointPath,
    entrypointBackup: entrypointBackupPath(codexInstall.entrypointPath),
    patchPath: bundle.patchPath,
    manifestPath: bundle.manifestPath,
    bundleSource: bundle.source,
    binarySha256: currentHash,
  };
}

function validatePatchBundle(codexInstall, bundle) {
  if (bundle.manifest.codexVersion !== codexInstall.version) {
    throw new Error(
      `Patch bundle version mismatch: manifest targets Codex ${bundle.manifest.codexVersion} but the machine has ${codexInstall.version}.`
    );
  }
  if (bundle.manifest.platform !== artifactPlatformKey()) {
    throw new Error(
      `Patch bundle platform mismatch: manifest targets ${bundle.manifest.platform} but this machine is ${artifactPlatformKey()}.`
    );
  }
}

function ensureEntrypointWrapper(codexInstall) {
  const backupPath = entrypointBackupPath(codexInstall.entrypointPath);
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(codexInstall.entrypointPath, backupPath);
  }

  fs.writeFileSync(
    codexInstall.entrypointPath,
    buildEntrypointWrapper({
      backupBinary: path.join(BACKUP_ROOT, `codex-${codexInstall.version}.original`),
      codexVersion: codexInstall.version,
      packageRoot: PACKAGE_ROOT,
    }),
  );
  fs.chmodSync(codexInstall.entrypointPath, 0o755);
  return backupPath;
}

function restoreEntrypoint(entrypointPath, backupPath) {
  if (!entrypointPath || !backupPath) {
    return;
  }
  if (!fs.existsSync(backupPath)) {
    return;
  }

  fs.copyFileSync(backupPath, entrypointPath);
  fs.chmodSync(entrypointPath, 0o755);
  fs.rmSync(backupPath, { force: true });
}

function entrypointBackupPath(entrypointPath) {
  return path.join(path.dirname(entrypointPath), ENTRYPOINT_BACKUP_BASENAME);
}

function buildEntrypointWrapper({ backupBinary, codexVersion, packageRoot }) {
  return `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORIGINAL_ENTRYPOINT = path.join(__dirname, ${JSON.stringify(ENTRYPOINT_BACKUP_BASENAME)});
const BACKUP_BINARY = ${JSON.stringify(backupBinary)};
const SLOPPYDISK_PACKAGE_ROOT = ${JSON.stringify(packageRoot)};
const CODEX_VERSION = ${JSON.stringify(codexVersion)};
const INSTALL_STATE_PATH = ${JSON.stringify(INSTALL_STATE_PATH)};

function executableName(baseName) {
  return process.platform === "win32" ? \`\${baseName}.exe\` : baseName;
}

function findVendorBinary(codexDir) {
  const root = path.join(codexDir, "node_modules");
  if (!fs.existsSync(root)) {
    return null;
  }
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name === executableName("codex") &&
        fullPath.includes(\`\${path.sep}vendor\${path.sep}\`) &&
        fullPath.includes(\`\${path.sep}codex\${path.sep}codex\`)
      ) {
        return fullPath;
      }
    }
  }
  return null;
}

function replaceBinaryAtomically(sourceBinary, targetBinary) {
  const tempTarget = \`\${targetBinary}.tmp\`;
  fs.copyFileSync(sourceBinary, tempTarget);
  fs.chmodSync(tempTarget, 0o755);
  fs.renameSync(tempTarget, targetBinary);
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(\`\${command} \${args.join(" ")} failed with exit code \${result.status}\`);
  }
}

function restoreToStock() {
  const codexDir = path.resolve(__dirname, "..");
  const vendorBinary = findVendorBinary(codexDir);
  if (fs.existsSync(BACKUP_BINARY) && vendorBinary) {
    replaceBinaryAtomically(BACKUP_BINARY, vendorBinary);
  } else {
    runChecked("npm", ["install", "-g", \`@openai/codex@\${CODEX_VERSION}\`]);
  }
  if (fs.existsSync(ORIGINAL_ENTRYPOINT)) {
    fs.copyFileSync(ORIGINAL_ENTRYPOINT, __filename);
    fs.chmodSync(__filename, 0o755);
    fs.rmSync(ORIGINAL_ENTRYPOINT, { force: true });
  }
  fs.rmSync(INSTALL_STATE_PATH, { force: true });
}

const sloppydiskInstalled = fs.existsSync(path.join(SLOPPYDISK_PACKAGE_ROOT, "package.json"));
if (!sloppydiskInstalled) {
  restoreToStock();
  const rerun = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" });
  process.exit(rerun.status ?? 0);
}

if (!fs.existsSync(ORIGINAL_ENTRYPOINT)) {
  throw new Error(\`Missing original Codex entrypoint backup at \${ORIGINAL_ENTRYPOINT}\`);
}

await import(pathToFileURL(ORIGINAL_ENTRYPOINT).href);
`;
}

function findVendorBinary(codexDir) {
  const root = path.join(codexDir, "node_modules");
  if (!fs.existsSync(root)) {
    return null;
  }

  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name === executableName("codex") &&
        fullPath.includes(`${path.sep}vendor${path.sep}`) &&
        fullPath.includes(`${path.sep}codex${path.sep}codex`)
      ) {
        return fullPath;
      }
    }
  }

  return null;
}

function applyBinaryPatch(referenceBinary, patchPath, outputBinary) {
  runChecked("zstd", [
    "-d",
    `--patch-from=${referenceBinary}`,
    "-f",
    patchPath,
    "-o",
    outputBinary,
  ]);
  fs.chmodSync(outputBinary, 0o755);
}

function replaceBinaryAtomically(sourceBinary, targetBinary) {
  const tempTarget = `${targetBinary}.tmp`;
  fs.copyFileSync(sourceBinary, tempTarget);
  fs.chmodSync(tempTarget, 0o755);
  fs.renameSync(tempTarget, targetBinary);
}

function artifactPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function executableName(baseName) {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

function targetTripleForCurrentPlatform() {
  if (process.platform === "linux" && process.arch === "x64") {
    return "x86_64-unknown-linux-musl";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "aarch64-unknown-linux-musl";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  if (process.platform === "win32" && process.arch === "arm64") {
    return "aarch64-pc-windows-msvc";
  }
  throw new Error(`Unsupported platform for sloppydisk: ${artifactPlatformKey()}`);
}

function releaseArtifactName(version) {
  return `sloppydisk-codex-v${version}-${artifactPlatformKey()}.patch.zst`;
}

function cleanupInstallState() {
  fs.rmSync(INSTALL_STATE_PATH, { force: true });
}

function readInstallState() {
  return fs.existsSync(INSTALL_STATE_PATH)
    ? JSON.parse(fs.readFileSync(INSTALL_STATE_PATH, "utf8"))
    : null;
}

function reinstallOfficialCodex(version) {
  runChecked("npm", ["install", "-g", `@openai/codex@${version}`]);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createChildEnv() {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (!pathEntries.includes(cargoBin)) {
    pathEntries.unshift(cargoBin);
  }
  return { ...process.env, PATH: pathEntries.join(path.delimiter) };
}

function ensureCommand(command, args, failureMessage) {
  const result = spawnSync(command, args, {
    env: CHILD_ENV,
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw new Error(failureMessage);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...CHILD_ENV, ...(options.env || {}) },
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${stdout ? `\nstdout:\n${stdout}` : ""}${stderr ? `\nstderr:\n${stderr}` : ""}`
    );
  }
  return result;
}

function assertSupportedCodexVersion(version) {
  if (!SUPPORTED_CODEX_VERSIONS.includes(version)) {
    throw new Error(`Codex ${version} is not supported by sloppydisk.`);
  }
}

function handleLifecycleError(lifecycle, message) {
  if (lifecycle) {
    console.warn(`[sloppydisk] ${message}`);
    return;
  }
  throw new Error(message);
}

module.exports = {
  PATCH_ARCHIVE_BASENAME,
  PATCH_MANIFEST_BASENAME,
  SUPPORTED_CODEX_VERSIONS,
  artifactPlatformKey,
  executableName,
  installSloppydisk,
  printStatus,
  releaseArtifactName,
  resolveCodexInstall,
  sha256File,
  targetTripleForCurrentPlatform,
  uninstallSloppydisk,
};
