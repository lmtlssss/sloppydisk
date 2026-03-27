#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { SUPPORTED_CODEX_VERSIONS, artifactPlatformKey } = require("../lib/patcher");

const repoRoot = path.resolve(__dirname, "..");
const codexVersion = SUPPORTED_CODEX_VERSIONS[0];
const platformKey = artifactPlatformKey();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slopex-smoke-"));

let tarballPath = null;

try {
  if (!codexVersion) {
    throw new Error("No supported Codex versions are configured.");
  }

  const realNpmRoot = runChecked("npm", ["root", "-g"], { cwd: repoRoot }).stdout.trim();
  const sourceCodexDir = path.join(realNpmRoot, "@openai", "codex");
  if (!fs.existsSync(sourceCodexDir)) {
    throw new Error(`Expected a global @openai/codex install at ${sourceCodexDir}`);
  }

  const sourceArtifact = path.join(
    os.homedir(),
    ".slopex",
    "artifacts",
    codexVersion,
    platformKey,
    executableName("codex")
  );
  if (!fs.existsSync(sourceArtifact)) {
    throw new Error(`Expected a cached slopex artifact at ${sourceArtifact}`);
  }

  const packInfo = JSON.parse(runChecked("npm", ["pack", "--json"], { cwd: repoRoot }).stdout)[0];
  tarballPath = path.join(repoRoot, packInfo.filename);

  const prefixDir = path.join(tempRoot, "prefix");
  const homeDir = path.join(tempRoot, "home");
  const env = createTestEnv(prefixDir, homeDir);
  const fakeNpmRoot = runChecked("npm", ["root", "-g"], { cwd: repoRoot, env }).stdout.trim();
  const fakeCodexDir = path.join(fakeNpmRoot, "@openai", "codex");
  ensureDir(path.dirname(fakeCodexDir));
  fs.cpSync(sourceCodexDir, fakeCodexDir, { recursive: true });

  const fakeVendorBinary = findVendorBinary(fakeCodexDir);
  if (!fakeVendorBinary) {
    throw new Error(`Could not find copied Codex vendor binary in ${fakeCodexDir}`);
  }
  const artifactSha256 = sha256File(sourceArtifact);
  if (sha256File(fakeVendorBinary) === artifactSha256) {
    const sourceBackup = path.join(
      os.homedir(),
      ".slopex",
      "backups",
      `codex-${codexVersion}.original`
    );
    if (!fs.existsSync(sourceBackup)) {
      throw new Error(
        `Copied Codex install is already patched and no original backup was found at ${sourceBackup}`
      );
    }
    fs.copyFileSync(sourceBackup, fakeVendorBinary);
    fs.chmodSync(fakeVendorBinary, 0o755);
  }
  const originalVendorSha256 = sha256File(fakeVendorBinary);

  const fakeArtifact = path.join(
    homeDir,
    ".slopex",
    "artifacts",
    codexVersion,
    platformKey,
    executableName("codex")
  );
  ensureDir(path.dirname(fakeArtifact));
  fs.copyFileSync(sourceArtifact, fakeArtifact);
  fs.chmodSync(fakeArtifact, 0o755);

  const configPath = path.join(homeDir, ".codex", "config.toml");
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(
    configPath,
    [
      'model = "gpt-5.4"',
      'service_tier = "fast"',
      "",
      "[notice]",
      "hide_rate_limit_model_nudge = true",
      ""
    ].join("\n")
  );

  runChecked("npm", ["install", "-g", tarballPath], { cwd: repoRoot, env });

  const installedConfig = fs.readFileSync(configPath, "utf8");
  assert(installedConfig.includes("# BEGIN slopex"), "slopex config block missing after install");
  assert(installedConfig.includes('model = "gpt-5.4"'), "user config was not preserved");
  assert(installedConfig.includes("[notice]"), "existing TOML table was not preserved");
  const slopexIndex = installedConfig.indexOf("# BEGIN slopex");
  const noticeIndex = installedConfig.indexOf("[notice]");
  assert(
    noticeIndex === -1 || slopexIndex < noticeIndex,
    "slopex config block was inserted after a TOML table header"
  );

  const installedVendorSha256 = sha256File(fakeVendorBinary);
  assert(installedVendorSha256 !== originalVendorSha256, "Codex binary did not change after install");
  assert(
    installedVendorSha256 === artifactSha256,
    "Installed Codex binary does not match the slopex artifact"
  );

  const backupPath = path.join(homeDir, ".slopex", "backups", `codex-${codexVersion}.original`);
  assert(fs.existsSync(backupPath), "Original Codex backup was not created");
  assert(
    sha256File(backupPath) === originalVendorSha256,
    "Original Codex backup does not match the pre-install binary"
  );

  const codexEntry = resolveCodexEntry(fakeCodexDir);
  runChecked("node", [codexEntry, "--help"], { cwd: repoRoot, env });

  const slopexBin = path.join(prefixDir, "bin", executableName("slopex"));
  runChecked(slopexBin, ["uninstall"], { cwd: repoRoot, env });

  const uninstalledConfig = fs.readFileSync(configPath, "utf8");
  assert(!uninstalledConfig.includes("# BEGIN slopex"), "slopex config block still present after uninstall");
  assert(uninstalledConfig.includes('model = "gpt-5.4"'), "user config changed after uninstall");
  assert(uninstalledConfig.includes("[notice]"), "existing TOML table changed after uninstall");
  assert(
    sha256File(fakeVendorBinary) === originalVendorSha256,
    "Codex binary was not restored to the original hash after uninstall"
  );
  runChecked("node", [codexEntry, "--help"], { cwd: repoRoot, env });

  runChecked("npm", ["install", "-g", tarballPath], { cwd: repoRoot, env });

  const reinstallConfig = fs.readFileSync(configPath, "utf8");
  assert(reinstallConfig.includes("# BEGIN slopex"), "slopex config block missing after reinstall");
  assert(
    sha256File(fakeVendorBinary) === artifactSha256,
    "Codex binary does not match the slopex artifact after reinstall"
  );

  fs.rmSync(backupPath, { force: true });
  runChecked(slopexBin, ["uninstall"], { cwd: repoRoot, env });

  const fallbackConfig = fs.readFileSync(configPath, "utf8");
  assert(!fallbackConfig.includes("# BEGIN slopex"), "slopex config block still present after fallback uninstall");
  assert(fallbackConfig.includes('model = "gpt-5.4"'), "user config changed after fallback uninstall");
  assert(fallbackConfig.includes("[notice]"), "existing TOML table changed after fallback uninstall");
  assert(
    sha256File(fakeVendorBinary) === originalVendorSha256,
    "Codex binary was not restored to the original hash after fallback uninstall"
  );
  runChecked("node", [codexEntry, "--help"], { cwd: repoRoot, env });

  console.log("Packaged install smoke test passed.");
} finally {
  if (tarballPath) {
    fs.rmSync(tarballPath, { force: true });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function resolveCodexEntry(codexDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(codexDir, "package.json"), "utf8"));
  const binField = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.codex;
  if (!binField) {
    throw new Error(`Could not resolve Codex entrypoint from ${path.join(codexDir, "package.json")}`);
  }
  return path.join(codexDir, binField);
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

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function createTestEnv(prefixDir, homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    npm_config_prefix: prefixDir,
    PATH: `${path.join(prefixDir, "bin")}${path.delimiter}${process.env.PATH || ""}`
  };
}

function executableName(baseName) {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${
        stdout ? `\nstdout:\n${stdout}` : ""
      }${stderr ? `\nstderr:\n${stderr}` : ""}`
    );
  }
  return result;
}
