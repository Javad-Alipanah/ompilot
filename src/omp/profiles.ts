import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface OmpProfileOptions {
  /** Blank inherits the launch environment. Literal "default" selects the base profile. */
  profile?: string;
  extraArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}

export interface OmpProfileContext {
  profile?: string;
  /** Setting-selected CLI value; args-selected profiles keep their original argument. */
  launchProfile?: string;
  label: string;
  key: string;
  source: "setting" | "args" | "environment" | "default";
  exists: boolean;
  baseConfigRoot: string;
  profileRoot: string;
  agentDir: string;
  dataDir: string;
  stateDir: string;
  cacheDir: string;
  sessionsDir: string;
  /** Effective launch workspace after an extraArgs --cwd override. */
  cwd: string;
  authDatabaseFile: string;
  configFile: string;
  configPaths: string[];
  projectConfigFile: string;
  overlayConfigPaths: string[];
}

/** Exact v18.4.10 dirs.ts validation, including Windows device names on every platform. */
export function normalizeProfileName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === "default") return undefined;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.endsWith(".") ||
    /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(normalized)
  )
    throw new Error(`Invalid OMP profile "${value}"`);
  return normalized;
}

// Launch flag consumption mirrors v18.4.10 cli/flag-tables.ts. These protect
// literal --profile tokens used as values, rather than interpreting them as flags.
const stringFlags = new Set([
  "--cwd",
  "--config",
  "--add-dir",
  "--mode",
  "--fork",
  "--provider",
  "--model",
  "--smol",
  "--slow",
  "--prewalk-into",
  "--plan-yolo-into",
  "--max-time",
  "--service-tier",
  "--api-key",
  "--system-prompt",
  "--system-prompt-template",
  "--append-system-prompt",
  "--provider-session-id",
  "--prompt-cache-key",
  "--session-dir",
  "--models",
  "--tools",
  "--thinking",
  "--export",
  "--hook",
  "--extension",
  "-e",
  "--trusted-extension",
  "--plugin-dir",
  "--skills",
  "--approval-mode",
  "--alias",
]);
const optionalFlags = new Set(["--resume", "-r", "--session", "--plan"]);
const valuelessFlags = new Set([
  "--help",
  "--version",
  "--allow-home",
  "--continue",
  "--from-claude",
  "--from-codex",
  "--no-session",
  "--no-tools",
  "--no-lsp",
  "--no-pty",
  "--hide-thinking",
  "--advisor",
  "--external-thinking",
  "--prewalk",
  "--no-prewalk",
  "--plan-yolo",
  "--print",
  "--print-thoughts",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-title",
  "--no-ui",
  "--auto-approve",
  "--yolo",
  "--omp-profile-boundary",
]);
const subcommands = new Set([
  "agents",
  "auth-broker",
  "auth-gateway",
  "bench",
  "browser-relay",
  "cleanse",
  "clip",
  "collab",
  "commit",
  "completions",
  "compress",
  "config",
  "dry-balance",
  "find",
  "gallery",
  "gc",
  "git",
  "grep",
  "grievances",
  "images",
  "install",
  "join",
  "login",
  "models",
  "play",
  "plugin",
  "predict",
  "ps",
  "read",
  "render",
  "say",
  "search",
  "setup",
  "share",
  "shell",
  "skill",
  "ssh",
  "stats",
  "stream",
  "tiny-models",
  "token",
  "toks",
  "ttsr",
  "update",
  "usage",
  "worktree",
]);
function unknownValueFlag(flag: string): boolean {
  return (
    flag.startsWith("--") &&
    !flag.includes("=") &&
    !stringFlags.has(flag) &&
    !optionalFlags.has(flag) &&
    !valuelessFlags.has(flag)
  );
}

function scanArguments(
  args: readonly string[],
  stripCwd = false,
): {
  profile?: string;
  stripped: string[];
  configs: string[];
  sessionDir?: string;
  cwd?: string;
} {
  const result: ReturnType<typeof scanArguments> = { stripped: [], configs: [] };
  let passThrough = false;
  let canDispatchSubcommand = true;
  let insertBoundary = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (passThrough) {
      result.stripped.push(arg);
      continue;
    }
    if (insertBoundary) {
      if (!arg.startsWith("-")) result.stripped.push("--omp-profile-boundary");
      insertBoundary = false;
    }
    if (arg === "--") {
      passThrough = true;
      result.stripped.push(arg);
      continue;
    }
    const profileFlag = arg === "--profile" || arg.startsWith("--profile=");
    const cwdFlag = stripCwd && (arg === "--cwd" || arg.startsWith("--cwd="));
    if (profileFlag || cwdFlag) {
      const equals = arg.indexOf("=");
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (profileFlag) {
        if (!value || (equals < 0 && value.startsWith("-")))
          throw new Error("--profile requires a profile name");
        result.profile = value.trim();
      } else {
        if (value === undefined) throw new Error("--cwd requires a directory");
        result.cwd = value;
      }
      const previous = result.stripped.at(-1);
      insertBoundary =
        previous !== undefined && (optionalFlags.has(previous) || unknownValueFlag(previous));
      continue;
    }
    if (canDispatchSubcommand && subcommands.has(arg)) {
      passThrough = true;
      result.stripped.push(arg);
      continue;
    }
    canDispatchSubcommand = false;
    result.stripped.push(arg);
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const takesValue = stringFlags.has(flag) || optionalFlags.has(flag) || unknownValueFlag(arg);
    let value = equals < 0 ? undefined : arg.slice(equals + 1);
    if (equals < 0 && takesValue && index + 1 < args.length) {
      const next = args[index + 1];
      if (stringFlags.has(flag) || !next.startsWith("-")) {
        value = next;
        result.stripped.push(next);
        index++;
      }
    }
    if (value !== undefined) {
      if (flag === "--config") result.configs.push(value);
      if (flag === "--session-dir") result.sessionDir = value;
      if (flag === "--cwd") result.cwd = value;
    }
  }
  return result;
}

/** Last actual --profile wins; flags after -- or a dispatched subcommand are literal. */
export function profileFromArgs(extraArgs: readonly string[]): string | undefined {
  const selected = scanArguments(extraArgs).profile;
  normalizeProfileName(selected);
  return selected;
}

/** Removes resolved global profile flags while preserving optional-value boundaries. */
export function stripProfileArgs(extraArgs: readonly string[]): string[] {
  return scanArguments(extraArgs).stripped;
}

/** Removes resolved profile/workspace flags before binding their effective absolute context. */
export function stripLaunchContextArgs(extraArgs: readonly string[]): string[] {
  return scanArguments(extraArgs, true).stripped;
}

/**
 * Resolves OMP 18.4.10 launch paths without opening settings, databases or dotenv files.
 * Directory variables supplied by OMP's later dotenv load can affect the running process;
 * callers should use observed RPC state for its actual session/model, rather than assume
 * this path resolver evaluates YAML, credentials, broker policy or dotenv contents.
 *
 * rpc/rpc-ui watch YAML global/project/overlay edits live, retaining last good values on
 * parse/validation failures. Runtime/CLI overrides still win. advisor.enabled is reconciled
 * live; prewalk.enabled disarms or arms an eligible main session, preserving an existing
 * prewalk state. modelRoles edits update advisor roles and future role resolution, but do
 * not replace the running main model; defaultThinkingLevel only seeds new sessions.
 * Profile, inherited environment and startup-loaded resources need a guarded OMP process
 * restart. Settings reload alone is not a profile switch or credential-isolation boundary.
 */
export function resolveProfileContext(options: OmpProfileOptions = {}): OmpProfileContext {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const home = options.homeDir ?? homedir();
  const launchCwd = options.cwd ?? process.cwd();
  const args = scanArguments(options.extraArgs ?? []);
  const setting = options.profile?.trim();
  if (setting && args.profile !== undefined)
    throw new Error("OMP profile setting conflicts with --profile in extraArgs");
  const envValue = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const selected = setting || (args.profile !== undefined ? args.profile : envValue);
  const profile = normalizeProfileName(selected);
  const source = setting
    ? "setting"
    : args.profile !== undefined
      ? "args"
      : envValue !== undefined
        ? "environment"
        : "default";
  const baseConfigRoot = paths.join(home, env.PI_CONFIG_DIR || ".omp");
  const profileRoot = profile ? paths.join(baseConfigRoot, "profiles", profile) : baseConfigRoot;
  const profileAgent = (name: string) => paths.join(baseConfigRoot, "profiles", name, "agent");
  const safeProfile = (value: string | undefined) => {
    try {
      return normalizeProfileName(value);
    } catch {
      return undefined;
    }
  };
  const inheritedProfile = safeProfile(envValue) ?? safeProfile(env.PI_PROFILE);
  const inheritedAgent = env.PI_CODING_AGENT_DIR;
  const agentOverride =
    inheritedProfile && inheritedAgent === profileAgent(inheritedProfile)
      ? undefined
      : inheritedAgent;
  const defaultAgent = paths.join(profileRoot, "agent");
  const agentDir =
    !profile && agentOverride ? paths.resolve(launchCwd, agentOverride) : defaultAgent;
  const xdgRoots = (kind: "DATA" | "STATE" | "CACHE") => {
    const value = env[`XDG_${kind}_HOME`];
    const root = value ? paths.join(value, "omp") : undefined;
    return root && profile ? paths.join(root, "profiles", profile) : root;
  };
  const categoryDir = (kind: "DATA" | "STATE" | "CACHE") => {
    const root = xdgRoots(kind);
    return (platform === "linux" || platform === "darwin") &&
      agentDir === defaultAgent &&
      root &&
      existsSync(root)
      ? root
      : agentDir;
  };
  const dataDir = categoryDir("DATA");
  const stateDir = categoryDir("STATE");
  const cacheDir = categoryDir("CACHE");
  const configPaths = [paths.join(agentDir, "config.yml"), paths.join(agentDir, "config.yaml")];
  const expandHome = (value: string) =>
    value === "~" ? home : /^~[/\\]/.test(value) ? paths.join(home, value.slice(2)) : value;
  const cwd = args.cwd ? paths.resolve(launchCwd, expandHome(args.cwd)) : launchCwd;
  const overlayConfigPaths = [
    ...(env.PI_CONFIG_FILES?.split(paths.delimiter).filter(Boolean) ?? []),
    ...args.configs,
  ].map((file) => paths.resolve(cwd, expandHome(file)));
  const sessionsDir = args.sessionDir
    ? paths.resolve(cwd, expandHome(args.sessionDir))
    : paths.join(dataDir, "sessions");
  return {
    profile,
    launchProfile: source === "setting" ? (profile ?? "default") : undefined,
    label: profile ?? "default",
    source,
    key: JSON.stringify([
      profile ?? "default",
      agentDir,
      dataDir,
      stateDir,
      cacheDir,
      sessionsDir,
      cwd,
    ]),
    exists:
      !profile ||
      [profileRoot, ...(["DATA", "STATE", "CACHE"] as const).map(xdgRoots)].some(
        (root) => root !== undefined && existsSync(root),
      ),
    baseConfigRoot,
    profileRoot,
    agentDir,
    dataDir,
    stateDir,
    cacheDir,
    sessionsDir,
    cwd,
    authDatabaseFile: paths.join(dataDir, "agent.db"),
    configFile: configPaths.find((file) => existsSync(file)) ?? configPaths[0],
    configPaths,
    projectConfigFile: paths.join(cwd, ".omp", "config.yml"),
    overlayConfigPaths,
  };
}

/** Existing valid real profile directories; never creates profiles or reads their contents. */
export async function listProfileContexts(
  options: OmpProfileOptions = {},
): Promise<OmpProfileContext[]> {
  const base = resolveProfileContext({ ...options, profile: undefined, extraArgs: [] });
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const roots = [paths.join(base.baseConfigRoot, "profiles")];
  if (platform === "linux" || platform === "darwin") {
    for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
      if (env[key]) roots.push(paths.join(env[key]!, "omp", "profiles"));
    }
  }
  const names = new Set<string>();
  for (const root of new Set(roots)) {
    try {
      for (const item of await fs.readdir(root, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        try {
          const name = normalizeProfileName(item.name);
          if (name) names.add(name);
        } catch {
          /* Invalid names never become selectors. */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return ["default", ...[...names].sort()].map((profile) =>
    resolveProfileContext({ ...options, profile, extraArgs: [] }),
  );
}
