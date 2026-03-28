const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PACKAGE_JSON = require(path.join(PACKAGE_ROOT, "package.json"));
const WORK_ROOT = path.join(os.homedir(), ".sloppydisk");
const SRC_ROOT = path.join(WORK_ROOT, "src");
const BACKUP_ROOT = path.join(WORK_ROOT, "backups");
const ARTIFACT_ROOT = path.join(WORK_ROOT, "artifacts");
const INSTALL_STATE_PATH = path.join(WORK_ROOT, "install-state.json");
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const CONTINUITY_ROOT = path.join(os.homedir(), ".codex", "obsidian_graph");
const CHILD_ENV = createChildEnv();

const SUPPORTED_CODEX_VERSIONS = ["0.117.0"];
const CODEX_SRC_URL = "https://github.com/openai/codex.git";

async function installSlopex({ postinstall = false } = {}) {
  ensureDir(WORK_ROOT);

  const codexInstall = resolveCodexInstall();
  if (!codexInstall) {
    const message = "Codex is not installed globally. Install it first with: npm install -g @openai/codex";
    if (postinstall) {
      console.warn(`[sloppydisk] ${message}`);
      return;
    }
    throw new Error(message);
  }

  assertSupportedCodexVersion(codexInstall.version);

  console.log(`[sloppydisk] Preparing to patch Codex ${codexInstall.version} locally...`);
  const patchedBinary = await buildPatchedBinaryLocally(codexInstall.version);

  ensureDir(BACKUP_ROOT);
  const backupBinary = path.join(BACKUP_ROOT, `codex-${codexInstall.version}.original`);
  if (!fs.existsSync(backupBinary)) {
    fs.copyFileSync(codexInstall.vendorBinary, backupBinary);
  }

  replaceBinaryAtomically(patchedBinary, codexInstall.vendorBinary);
  writeManagedConfigBlock();

  const state = {
    installedAt: new Date().toISOString(),
    version: PACKAGE_JSON.version,
    codexVersion: codexInstall.version,
    vendorBinary: codexInstall.vendorBinary,
    backupBinary,
    artifactBinary: patchedBinary,
    binarySha256: sha256File(codexInstall.vendorBinary)
  };
  fs.writeFileSync(INSTALL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

  console.log(`sloppydisk patched Codex ${codexInstall.version}`);
  console.log(`patched binary: ${codexInstall.vendorBinary}`);
  console.log(`continuity root: ${CONTINUITY_ROOT}`);
}

async function buildPatchedBinaryLocally(version) {
  const repoDir = path.join(SRC_ROOT, `rust-v${version}`);
  const artifactPath = path.join(ARTIFACT_ROOT, version, artifactPlatformKey(), executableName("codex"));
  const devSourceDir = "/root/codex-src-main"; // Known local dev source

  if (fs.existsSync(artifactPath)) {
    console.log(`[sloppydisk] Using cached patched binary at ${artifactPath}`);
    return artifactPath;
  }

  ensureDir(path.dirname(artifactPath));
  ensureDir(SRC_ROOT);

  if (!fs.existsSync(repoDir)) {
    if (fs.existsSync(devSourceDir)) {
       console.log(`[sloppydisk] Linking local development source from ${devSourceDir}...`);
       fs.symlinkSync(devSourceDir, repoDir, 'dir');
    } else {
       console.log(`[sloppydisk] Cloning Codex source to ${repoDir}...`);
       // Note: Standard OpenAI codex tags are often just 'vX.Y.Z'
       runChecked("git", ["clone", "--depth", "1", "--branch", `v${version}`, CODEX_SRC_URL, repoDir]);
    }
  }

  const patchFile = path.join(PACKAGE_ROOT, "patches", `rust-v${version}.patch`);
  if (!fs.existsSync(patchFile)) {
    throw new Error(`Missing patch file for version ${version} at ${patchFile}`);
  }

  console.log(`[sloppydisk] Applying patch ${path.basename(patchFile)}...`);
  runChecked("git", ["reset", "--hard"], { cwd: repoDir });
  runChecked("patch", ["-p1", "-i", patchFile], { cwd: repoDir });

  console.log(`[sloppydisk] Compiling patched Codex (this may take a few minutes)...`);
  const crateDir = path.join(repoDir, "codex-rs");
  runChecked("cargo", ["build", "--release", "-p", "codex-cli", "--bin", "codex"], { cwd: crateDir });

  const buildOutput = path.join(crateDir, "target", "release", executableName("codex"));
  if (!fs.existsSync(buildOutput)) {
    throw new Error(`Build failed: could not find output at ${buildOutput}`);
  }

  fs.copyFileSync(buildOutput, artifactPath);
  console.log(`[sloppydisk] Successfully built and cached patched binary.`);
  return artifactPath;
}

async function printStatus() {
  const codexInstall = resolveCodexInstall();
  if (!codexInstall) {
    console.log("Codex is not installed globally.");
    return;
  }

  const state = readInstallState();
  const configText = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : "";
  const managedConfigPresent = configText.includes("# BEGIN slopex");

  console.log(`codex version: ${codexInstall.version}`);
  console.log(`codex dir: ${codexInstall.codexDir}`);
  console.log(`supported by sloppydisk: ${SUPPORTED_CODEX_VERSIONS.includes(codexInstall.version)}`);
  console.log(`sloppydisk config block: ${managedConfigPresent ? "present" : "missing"}`);

  if (!state) {
    console.log("sloppydisk install state: not found");
    return;
  }

  console.log(`sloppydisk version: ${state.version}`);
  console.log(`backup binary: ${state.backupBinary}`);
  console.log(`patched binary hash matches state: ${sha256File(codexInstall.vendorBinary) === state.binarySha256}`);
}

async function uninstallSlopex() {
  const state = readInstallState();
  if (!state) {
    throw new Error("No sloppydisk install state found.");
  }

  if (fs.existsSync(state.backupBinary)) {
    replaceBinaryAtomically(state.backupBinary, state.vendorBinary);
    console.log(`Restored original Codex binary from ${state.backupBinary}`);
  } else {
    console.warn(`Backup not found at ${state.backupBinary}. Reinstalling @openai/codex...`);
    reinstallOfficialCodex(state.codexVersion);
  }

  removeManagedConfigBlock();
  fs.rmSync(INSTALL_STATE_PATH, { force: true });
}

function resolveCodexInstall() {
  try {
    const npmRoot = runChecked("npm", ["root", "-g"]).stdout.trim();
    const codexDir = path.join(npmRoot, "@openai", "codex");
    if (!fs.existsSync(codexDir)) return null;

    const packageJson = JSON.parse(fs.readFileSync(path.join(codexDir, "package.json"), "utf8"));
    const vendorBinary = findVendorBinary(codexDir);
    if (!vendorBinary) throw new Error("Could not locate Codex vendor binary.");

    return { codexDir, version: packageJson.version, vendorBinary };
  } catch (e) {
    return null;
  }
}

function findVendorBinary(codexDir) {
  const root = path.join(codexDir, "node_modules");
  if (!fs.existsSync(root)) return null;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name === "codex" && fullPath.includes("vendor")) {
        return fullPath;
      }
    }
  }
  return null;
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

function writeManagedConfigBlock() {
  ensureDir(path.dirname(CONFIG_PATH));
  const managedBlock = [
    "# BEGIN slopex",
    'experimental_auto_compact_mode = "reset"',
    'experimental_obsidian_graph_root = "~/.codex/obsidian_graph"',
    "experimental_obsidian_graph_background_agent = true",
    "# END slopex"
  ].join("\n");

  const existing = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : "";
  const stripped = existing.replace(/\n?# BEGIN slopex[\s\S]*?# END slopex\n?/g, "\n").trim();
  fs.writeFileSync(CONFIG_PATH, `${(stripped + "\n\n" + managedBlock).trim()}\n`);
}

function removeManagedConfigBlock() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  const existing = fs.readFileSync(CONFIG_PATH, "utf8");
  const next = existing.replace(/\n?# BEGIN slopex[\s\S]*?# END slopex\n?/g, "\n");
  fs.writeFileSync(CONFIG_PATH, `${next.trim()}\n`);
}

function readInstallState() {
  return fs.existsSync(INSTALL_STATE_PATH) ? JSON.parse(fs.readFileSync(INSTALL_STATE_PATH, "utf8")) : null;
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
  if (!pathEntries.includes(cargoBin)) pathEntries.unshift(cargoBin);
  return { ...process.env, PATH: pathEntries.join(path.delimiter) };
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: { ...CHILD_ENV, ...(options.env || {}) }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed with code ${result.status}\n${result.stderr}`);
  return result;
}

function assertSupportedCodexVersion(version) {
  if (!SUPPORTED_CODEX_VERSIONS.includes(version)) throw new Error(`Codex ${version} not supported.`);
}

module.exports = { installSlopex, printStatus, uninstallSlopex };
