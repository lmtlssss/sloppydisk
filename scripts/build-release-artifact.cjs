#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  PATCH_ARCHIVE_BASENAME,
  PATCH_MANIFEST_BASENAME,
  SUPPORTED_CODEX_VERSIONS,
  artifactPlatformKey,
  releaseArtifactName,
  resolveCodexInstall,
  sha256File,
  targetTripleForCurrentPlatform,
} = require("../lib/patcher");

const SLOPPYDISK_HOME = path.join(os.homedir(), ".sloppydisk");
const SOURCE_ROOT = path.join(SLOPPYDISK_HOME, "codex-src");
const ARTIFACT_ROOT = path.join(SLOPPYDISK_HOME, "artifacts");
const REPO_ARTIFACT_ROOT = path.join(process.cwd(), "artifacts");
const BUILD_PROFILE = "release";
const TARGET_TRIPLE = targetTripleForCurrentPlatform();
const CHILD_ENV = createChildEnv();

const CODEX_SUPPORT = {
  "0.118.0": {
    tag: "rust-v0.118.0",
    patchFile: path.join(__dirname, "..", "patches", "rust-v0.118.0.patch"),
    rustyV8Tag: "rusty-v8-v146.4.0",
  },
};

const codexVersion = SUPPORTED_CODEX_VERSIONS[0];
if (!codexVersion) {
  throw new Error("No supported Codex versions are configured.");
}

const support = CODEX_SUPPORT[codexVersion];
if (!support) {
  throw new Error(`No build recipe is configured for Codex ${codexVersion}.`);
}

ensureBuildPrerequisites();
ensurePatchFileExists(support.patchFile);

const stockBinary = resolveStockBinary(codexVersion);
const repoDir = ensurePatchedSourceCheckout(support.tag, support.patchFile);
const prebuiltV8 = ensureRustyV8Prebuilt(support.rustyV8Tag);
buildPatchedCodex(repoDir, prebuiltV8);

const builtBinary = path.join(
  repoDir,
  "codex-rs",
  "target",
  TARGET_TRIPLE,
  BUILD_PROFILE,
  "codex"
);
if (!fs.existsSync(builtBinary)) {
  throw new Error(`Expected built binary at ${builtBinary}, but it was not found.`);
}

maybeStripBinary(builtBinary);

const manifest = createManifest(stockBinary, builtBinary);
const cacheBundleDir = path.join(ARTIFACT_ROOT, codexVersion, artifactPlatformKey());
const packagedBundleDir = path.join(REPO_ARTIFACT_ROOT, codexVersion, artifactPlatformKey());

writeBundle(cacheBundleDir, stockBinary, builtBinary, manifest);
writeBundle(packagedBundleDir, stockBinary, builtBinary, manifest);
verifyBundle(path.join(cacheBundleDir, PATCH_ARCHIVE_BASENAME), stockBinary, manifest.patchedSha256);
verifyBundle(path.join(packagedBundleDir, PATCH_ARCHIVE_BASENAME), stockBinary, manifest.patchedSha256);

console.log(`stock binary: ${stockBinary}`);
console.log(`patched binary: ${builtBinary}`);
console.log(`stock size: ${formatSize(fs.statSync(stockBinary).size)}`);
console.log(`patched size: ${formatSize(fs.statSync(builtBinary).size)}`);
console.log(`patch size: ${formatSize(fs.statSync(path.join(packagedBundleDir, PATCH_ARCHIVE_BASENAME)).size)}`);
console.log(`packaged manifest: ${path.join(packagedBundleDir, PATCH_MANIFEST_BASENAME)}`);
console.log(`release asset name: ${releaseArtifactName(codexVersion)}`);

function ensureBuildPrerequisites() {
  ensureCommand("git", ["--version"], "Install git before building a sloppydisk release bundle.");
  ensureCommand(
    "cargo",
    ["--version"],
    "Install Rust and Cargo before building a sloppydisk release bundle: https://rustup.rs"
  );
  ensureCommand(
    "rustup",
    ["--version"],
    "Install rustup before building a sloppydisk release bundle."
  );
  ensureCommand(
    "pkg-config",
    ["--version"],
    "Install pkg-config before building a sloppydisk release bundle."
  );
  ensureCommand(
    "zstd",
    ["--version"],
    "Install zstd before building a sloppydisk release bundle."
  );
  ensureCommand(
    "curl",
    ["--version"],
    "Install curl before building a sloppydisk release bundle."
  );

  if (process.platform === "linux") {
    ensureCommand(
      "musl-gcc",
      ["--version"],
      "Linux release bundles require musl-tools so Codex can be built for the official musl vendor target."
    );
  }

  const installedTargets = runChecked("rustup", ["target", "list", "--installed"]).stdout;
  if (!installedTargets.split(/\r?\n/).includes(TARGET_TRIPLE)) {
    runInherited("rustup", ["target", "add", TARGET_TRIPLE]);
  }
}

function ensurePatchFileExists(patchFile) {
  if (!fs.existsSync(patchFile)) {
    throw new Error(`Missing sloppydisk patch file: ${patchFile}`);
  }
}

function resolveStockBinary(expectedVersion) {
  const codexInstall = resolveCodexInstall();
  if (!codexInstall) {
    throw new Error("Install @openai/codex globally before building a sloppydisk release bundle.");
  }
  if (codexInstall.version !== expectedVersion) {
    throw new Error(
      `Global Codex version mismatch. Expected ${expectedVersion}, found ${codexInstall.version}.`
    );
  }

  const backupBinary = path.join(SLOPPYDISK_HOME, "backups", `codex-${expectedVersion}.original`);
  if (fs.existsSync(backupBinary)) {
    return backupBinary;
  }
  return codexInstall.vendorBinary;
}

function ensureSourceCheckout(tag) {
  ensureDir(SOURCE_ROOT);
  const repoDir = path.join(SOURCE_ROOT, tag);
  if (!fs.existsSync(repoDir)) {
    runInherited("git", [
      "clone",
      "--branch",
      tag,
      "--depth",
      "1",
      "https://github.com/openai/codex.git",
      repoDir,
    ]);
    return repoDir;
  }

  const describe = runChecked("git", ["-C", repoDir, "describe", "--tags", "--exact-match"], {
    allowFailure: true,
  });
  if (describe.status !== 0 || describe.stdout.trim() !== tag) {
    fs.rmSync(repoDir, { recursive: true, force: true });
    return ensureSourceCheckout(tag);
  }
  return repoDir;
}

function ensurePatchedSourceCheckout(tag, patchFile) {
  let repoDir = ensureSourceCheckout(tag);
  if (applyPatchIfNeeded(repoDir, patchFile, { allowReclone: true, tag })) {
    return repoDir;
  }

  repoDir = ensureSourceCheckout(tag);
  if (applyPatchIfNeeded(repoDir, patchFile, { allowReclone: false, tag })) {
    return repoDir;
  }

  throw new Error(`Unable to apply sloppydisk patch cleanly in ${repoDir}. Delete ${repoDir} and try again.`);
}

function applyPatchIfNeeded(repoDir, patchFile, { allowReclone, tag }) {
  const applyCheck = runChecked("git", ["-C", repoDir, "apply", "--check", patchFile], {
    allowFailure: true,
  });
  if (applyCheck.status === 0) {
    runInherited("git", ["-C", repoDir, "apply", patchFile]);
    return true;
  }

  const reverseCheck = runChecked(
    "git",
    ["-C", repoDir, "apply", "-R", "--check", patchFile],
    { allowFailure: true }
  );
  if (reverseCheck.status === 0) {
    console.log("sloppydisk patch already applied in cached source checkout");
    return true;
  }

  if (allowReclone) {
    console.warn(`cached checkout at ${repoDir} drifted; recloning ${tag} before retrying`);
    fs.rmSync(repoDir, { recursive: true, force: true });
    return false;
  }

  return false;
}

function buildPatchedCodex(repoDir, prebuiltV8) {
  runInherited(
    "cargo",
    [
      "build",
      "--profile",
      BUILD_PROFILE,
      "--target",
      TARGET_TRIPLE,
      "-p",
      "codex-cli",
      "--bin",
      "codex",
    ],
    {
      cwd: path.join(repoDir, "codex-rs"),
      env: {
        CODEX_SKIP_VENDORED_BWRAP: process.platform === "linux" ? "1" : "0",
        RUSTY_V8_ARCHIVE: prebuiltV8.archivePath,
        RUSTY_V8_SRC_BINDING_PATH: prebuiltV8.bindingPath,
      },
    }
  );
}

function ensureRustyV8Prebuilt(rustyV8Tag) {
  const cacheDir = path.join(SLOPPYDISK_HOME, "rusty-v8", rustyV8Tag, TARGET_TRIPLE);
  ensureDir(cacheDir);

  const archiveName = `librusty_v8_release_${TARGET_TRIPLE}.a.gz`;
  const bindingName = `src_binding_release_${TARGET_TRIPLE}.rs`;
  const archivePath = path.join(cacheDir, archiveName);
  const bindingPath = path.join(cacheDir, bindingName);
  const baseUrl = `https://github.com/openai/codex/releases/download/${rustyV8Tag}`;

  downloadFileIfNeeded(`${baseUrl}/${archiveName}`, archivePath);
  downloadFileIfNeeded(`${baseUrl}/${bindingName}`, bindingPath);

  return { archivePath, bindingPath };
}

function maybeStripBinary(binaryPath) {
  if (process.platform === "win32") {
    return;
  }
  const stripCheck = spawnSync("strip", ["--version"], {
    env: CHILD_ENV,
    stdio: "ignore",
  });
  if (stripCheck.status !== 0) {
    return;
  }
  runChecked("strip", [binaryPath], { allowFailure: false });
}

function createManifest(stockBinary, builtBinary) {
  return {
    codexVersion,
    platform: artifactPlatformKey(),
    targetTriple: TARGET_TRIPLE,
    createdAt: new Date().toISOString(),
    stockSha256: sha256File(stockBinary),
    officialSha256: sha256File(stockBinary),
    patchedSha256: sha256File(builtBinary),
    stockSize: fs.statSync(stockBinary).size,
    patchedSize: fs.statSync(builtBinary).size,
    patchFile: PATCH_ARCHIVE_BASENAME,
    tool: "zstd --patch-from",
  };
}

function writeBundle(bundleDir, stockBinary, builtBinary, manifest) {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  ensureDir(bundleDir);

  const patchPath = path.join(bundleDir, PATCH_ARCHIVE_BASENAME);
  runChecked("zstd", [
    `--patch-from=${stockBinary}`,
    "-19",
    "-T0",
    "-f",
    builtBinary,
    "-o",
    patchPath,
  ]);

  const finalManifest = {
    ...manifest,
    patchSha256: sha256File(patchPath),
    patchSize: fs.statSync(patchPath).size,
  };
  fs.writeFileSync(
    path.join(bundleDir, PATCH_MANIFEST_BASENAME),
    `${JSON.stringify(finalManifest, null, 2)}\n`
  );
}

function verifyBundle(patchPath, stockBinary, expectedPatchedSha256) {
  const verifyOutput = `${patchPath}.verify`;
  runChecked("zstd", [
    "-d",
    `--patch-from=${stockBinary}`,
    "-f",
    patchPath,
    "-o",
    verifyOutput,
  ]);
  try {
    const verifySha256 = sha256File(verifyOutput);
    if (verifySha256 !== expectedPatchedSha256) {
      throw new Error(
        `Patch verification failed for ${patchPath}. Expected ${expectedPatchedSha256}, got ${verifySha256}.`
      );
    }
  } finally {
    fs.rmSync(verifyOutput, { force: true });
  }
}

function downloadFileIfNeeded(url, destinationPath) {
  if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).size > 0) {
    return;
  }
  ensureDir(path.dirname(destinationPath));
  runChecked("curl", ["-L", "-f", "-sS", "-o", destinationPath, url]);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)}${units[index]}`;
}

function createChildEnv() {
  const cargoBin = path.join(os.homedir(), ".cargo", "bin");
  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  if (!pathEntries.includes(cargoBin)) {
    pathEntries.unshift(cargoBin);
  }
  return {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
  };
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

function runInherited(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...CHILD_ENV,
      ...(options.env || {}),
    },
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...CHILD_ENV,
      ...(options.env || {}),
    },
    encoding: "utf8",
  });
  if (!options.allowFailure && result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${stdout ? `\nstdout:\n${stdout}` : ""}${stderr ? `\nstderr:\n${stderr}` : ""}`
    );
  }
  return result;
}
