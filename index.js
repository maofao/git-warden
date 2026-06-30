#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const process = require("process");

const TIMESTAMP_FILE = path.join(os.homedir(), ".git-activity-guard-timestamp");
const CONFIG_FILE = path.join(os.homedir(), ".git-warden.json");
const REPO_CONFIG_FILE = ".git-warden.json";
const DEFAULT_THRESHOLD_SECONDS = 3600;
const DANGEROUS_SUBCOMMANDS = new Set(["push", "commit", "checkout"]);

function parsePositiveInt(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function createDefaultConfig() {
  const payload = {
    thresholdSeconds: DEFAULT_THRESHOLD_SECONDS,
  };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return createDefaultConfig();
    }
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return createDefaultConfig();
    }

    return parsed;
  } catch {
    // If config is unreadable/corrupted, recover to safe defaults.
    return createDefaultConfig();
  }
}

function loadRepoConfig(repoRoot) {
  try {
    const repoConfigPath = path.join(repoRoot, REPO_CONFIG_FILE);
    if (!fs.existsSync(repoConfigPath)) {
      return null;
    }

    const raw = fs.readFileSync(repoConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function findGitRepoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  return result.stdout.trim();
}

function getThresholdSeconds() {
  const fromEnv = parsePositiveInt(process.env.GIT_ACTIVITY_THRESHOLD);
  if (fromEnv !== null) {
    return fromEnv;
  }

  const repoRoot = findGitRepoRoot();
  if (repoRoot) {
    const repoConfig = loadRepoConfig(repoRoot);
    if (repoConfig) {
      const fromRepoConfig =
        parsePositiveInt(repoConfig.thresholdSeconds) ??
        parsePositiveInt(repoConfig.threshold_seconds);
      if (fromRepoConfig !== null) {
        return fromRepoConfig;
      }
    }
  }

  const config = loadConfig();
  const fromConfig =
    parsePositiveInt(config.thresholdSeconds) ??
    parsePositiveInt(config.threshold_seconds);
  if (fromConfig !== null) {
    return fromConfig;
  }

  return DEFAULT_THRESHOLD_SECONDS;
}

function updateTimestamp() {
  fs.writeFileSync(TIMESTAMP_FILE, String(Date.now()), "utf8");
}

function getIdleSeconds() {
  if (!fs.existsSync(TIMESTAMP_FILE)) {
    return 0;
  }

  const lastRaw = fs.readFileSync(TIMESTAMP_FILE, "utf8").trim();
  const lastTimestamp = Number.parseInt(lastRaw, 10);

  if (Number.isNaN(lastTimestamp) || lastTimestamp <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor((Date.now() - lastTimestamp) / 1000));
}

function askConfirmation(commandText, idleSeconds) {
  const idleMinutes = Math.round(idleSeconds / 60);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      `Warning: terminal idle for about ${idleMinutes} minute(s). Run "${commandText}"? (y/n): `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase().startsWith("y"));
      }
    );
  });
}

function isInteractiveSession() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ensureAllowedByIdle(subCommand, args, thresholdSeconds) {
  if (!DANGEROUS_SUBCOMMANDS.has(subCommand)) {
    return { allowed: true, exitCode: 0 };
  }

  const idleSeconds = getIdleSeconds();
  if (idleSeconds <= thresholdSeconds) {
    return { allowed: true, exitCode: 0 };
  }

  const commandText = `git ${[subCommand, ...args].join(" ")}`.trim();
  if (!isInteractiveSession()) {
    console.error(
      `git-warden blocked "${commandText}" after ${idleSeconds}s idle in non-interactive session.`
    );
    return { allowed: false, exitCode: 1 };
  }

  const confirmed = await askConfirmation(commandText, idleSeconds);
  if (!confirmed) {
    console.log("Command cancelled.");
    return { allowed: false, exitCode: 0 };
  }

  return { allowed: true, exitCode: 0 };
}

function runGit(args) {
  const result = spawnSync("git", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  process.exit(1);
}

async function runGitWardenHookCheck(args) {
  const subCommand = args[0];
  if (!subCommand) {
    console.error("Usage: git-warden hook-check <commit|push|checkout>");
    process.exit(1);
  }

  if (!DANGEROUS_SUBCOMMANDS.has(subCommand)) {
    process.exit(0);
  }

  const thresholdSeconds = getThresholdSeconds();
  const checkResult = await ensureAllowedByIdle(subCommand, [], thresholdSeconds);
  if (checkResult.allowed) {
    process.exit(0);
  }
  process.exit(1);
}

function ensureExecutableIfPossible(filePath) {
  if (process.platform === "win32") {
    return;
  }

  const mode = fs.statSync(filePath).mode | 0o111;
  fs.chmodSync(filePath, mode);
}

function writeHook(hooksDir, hookName, body) {
  const hookPath = path.join(hooksDir, hookName);
  fs.writeFileSync(hookPath, body, "utf8");
  ensureExecutableIfPossible(hookPath);
}

function buildHookBody(checkCommand) {
  return `#!/bin/sh
set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOCAL_WARDEN="$REPO_ROOT/node_modules/.bin/git-warden"

if command -v git-warden >/dev/null 2>&1; then
  git-warden ${checkCommand}
elif [ -x "$LOCAL_WARDEN" ]; then
  "$LOCAL_WARDEN" ${checkCommand}
else
  echo "git-warden is required but not found. Install globally or run npm install."
  exit 1
fi
`;
}

function buildTouchHookBody() {
  return `#!/bin/sh
set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOCAL_WARDEN="$REPO_ROOT/node_modules/.bin/git-warden"

if command -v git-warden >/dev/null 2>&1; then
  git-warden touch
elif [ -x "$LOCAL_WARDEN" ]; then
  "$LOCAL_WARDEN" touch
fi
`;
}

function runInitCommand() {
  const repoRoot = findGitRepoRoot();
  if (!repoRoot) {
    console.error("git-warden init must be run inside a git repository.");
    process.exit(1);
  }

  const hooksDir = path.join(repoRoot, ".git", "hooks");
  if (!fs.existsSync(hooksDir)) {
    console.error("Cannot find .git/hooks directory.");
    process.exit(1);
  }

  const repoConfigPath = path.join(repoRoot, REPO_CONFIG_FILE);
  if (!fs.existsSync(repoConfigPath)) {
    const initialConfig = {
      thresholdSeconds: DEFAULT_THRESHOLD_SECONDS,
    };
    fs.writeFileSync(repoConfigPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    console.log(`Created ${REPO_CONFIG_FILE} with thresholdSeconds=${DEFAULT_THRESHOLD_SECONDS}.`);
  }

  writeHook(hooksDir, "pre-commit", buildHookBody("hook-check commit"));
  writeHook(hooksDir, "pre-push", buildHookBody("hook-check push"));
  writeHook(hooksDir, "post-checkout", buildTouchHookBody());

  console.log("Installed git-warden hooks: pre-commit, pre-push, post-checkout.");
  console.log("Hooks validate idle time for commit/push and refresh timestamp on checkout.");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: git-warden <git-subcommand|init|hook-check|touch> [args]");
    process.exit(1);
  }

  if (args[0] === "init") {
    runInitCommand();
    process.exit(0);
  }

  if (args[0] === "touch") {
    updateTimestamp();
    process.exit(0);
  }

  if (args[0] === "hook-check") {
    await runGitWardenHookCheck(args.slice(1));
    return;
  }

  const subCommand = args[0];
  const thresholdSeconds = getThresholdSeconds();
  const checkResult = await ensureAllowedByIdle(subCommand, args.slice(1), thresholdSeconds);
  if (!checkResult.allowed) {
    process.exit(checkResult.exitCode);
  }

  updateTimestamp();
  runGit(args);
}

main().catch((error) => {
  console.error("git-warden failed:", error);
  process.exit(1);
});
