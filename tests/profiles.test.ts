import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProfileContexts, normalizeProfileName, profileFromArgs, resolveProfileContext, stripProfileArgs, stripLaunchContextArgs } from "../src/omp/profiles";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "omp-profile-test-"));
  directories.push(homeDir);
  return { homeDir, cwd: join(homeDir, "workspace"), env: {}, platform: "linux" as const };
}

test("validates OMP 18.4.10 profile names and explicit default", () => {
  expect(normalizeProfileName(" audn ")).toBe("audn");
  expect(normalizeProfileName("default")).toBeUndefined();
  expect(normalizeProfileName(" ")).toBeUndefined();
  expect(normalizeProfileName("a".repeat(64))).toHaveLength(64);
  for (const value of ["../outside", "UPPER", ".", "..", "trailing.", "con", "prn.txt", "lpt9", "a".repeat(65)]) {
    expect(() => normalizeProfileName(value)).toThrow(/Invalid OMP profile/);
  }
});

test("selects setting, last CLI profile, canonical env, legacy env, then default", async () => {
  const options = await fixture();
  expect(resolveProfileContext({ ...options, profile: "audn", env: { OMP_PROFILE: "abliteration" } })).toMatchObject({ profile: "audn", launchProfile: "audn", label: "audn", source: "setting" });
  expect(resolveProfileContext({ ...options, profile: " ", extraArgs: ["--profile=first", "--profile", "audn"], env: { OMP_PROFILE: "abliteration" } })).toMatchObject({ profile: "audn", launchProfile: undefined, source: "args" });
  expect(resolveProfileContext({ ...options, env: { OMP_PROFILE: "audn", PI_PROFILE: "abliteration" } })).toMatchObject({ profile: "audn", source: "environment" });
  expect(resolveProfileContext({ ...options, env: { PI_PROFILE: "abliteration" } }).profile).toBe("abliteration");
  expect(resolveProfileContext(options)).toMatchObject({ profile: undefined, label: "default", source: "default" });
});

test("explicit default blocks inherited profiles and empty canonical env blocks legacy", async () => {
  const options = await fixture();
  expect(resolveProfileContext({ ...options, profile: "default", env: { OMP_PROFILE: "audn" } })).toMatchObject({ profile: undefined, launchProfile: "default", source: "setting" });
  expect(resolveProfileContext({ ...options, extraArgs: ["--profile=default"], env: { OMP_PROFILE: "audn" } })).toMatchObject({ profile: undefined, launchProfile: undefined, source: "args" });
  expect(resolveProfileContext({ ...options, extraArgs: ["--profile", " "], env: { OMP_PROFILE: "audn" } })).toMatchObject({ profile: undefined, source: "args" });
  expect(resolveProfileContext({ ...options, env: { OMP_PROFILE: "", PI_PROFILE: "audn" } }).profile).toBeUndefined();
  expect(() => resolveProfileContext({ ...options, profile: "audn", extraArgs: ["--profile=audn"] })).toThrow(/conflict/i);
});

test("profile flags respect launch flag value consumption and end-of-options", () => {
  expect(profileFromArgs(["--system-prompt", "--profile", "audn"])).toBeUndefined();
  expect(profileFromArgs(["--config", "overlay.yml", "--profile", "audn"])).toBe("audn");
  expect(profileFromArgs(["--plan", "--profile=audn"])).toBe("audn");
  expect(profileFromArgs(["--custom-extension", "value", "--profile=audn"])).toBe("audn");
  expect(profileFromArgs(["--print", "--profile=audn"])).toBe("audn");
  expect(profileFromArgs(["--", "--profile=audn"])).toBeUndefined();
  expect(profileFromArgs(["models", "--profile=audn"])).toBeUndefined();
  expect(profileFromArgs(["--profile", "audn", "models"])).toBe("audn");
  expect(profileFromArgs(["--profile=../invalid", "--profile=audn"])).toBe("audn");
  expect(profileFromArgs(["--profile=--invalid", "--profile=audn"])).toBe("audn");
  for (const args of [["--profile"], ["--profile="], ["--profile", "--print"]]) expect(() => profileFromArgs(args)).toThrow(/requires a profile name/);
});

test("named profile isolates state and ignores a custom agent override", async () => {
  const options = await fixture();
  const context = resolveProfileContext({ ...options, profile: "audn", env: { PI_CODING_AGENT_DIR: "/custom/agent", PI_CONFIG_DIR: ".custom-omp" } });
  const root = join(options.homeDir, ".custom-omp", "profiles", "audn");
  expect(context).toMatchObject({ baseConfigRoot: join(options.homeDir, ".custom-omp"), profileRoot: root, agentDir: join(root, "agent"), configFile: join(root, "agent", "config.yml"), dataDir: join(root, "agent"), stateDir: join(root, "agent"), cacheDir: join(root, "agent"), sessionsDir: join(root, "agent", "sessions"), authDatabaseFile: join(root, "agent", "agent.db") });
  expect(context.key).not.toBe(resolveProfileContext({ ...options, profile: "abliteration" }).key);
});

test("stripping profile flags preserves other values, terminator and optional argument boundaries", () => {
  expect(stripProfileArgs(["--config", "overlay.yml", "--profile=audn", "--thinking", "high", "--", "--profile=literal"])).toEqual(["--config", "overlay.yml", "--thinking", "high", "--", "--profile=literal"]);
  expect(stripProfileArgs(["--system-prompt", "--profile", "literal"])).toEqual(["--system-prompt", "--profile", "literal"]);
  expect(stripProfileArgs(["--resume", "--profile", "audn", "prompt"])).toEqual(["--resume", "--omp-profile-boundary", "prompt"]);
});

test("default honors custom agent dirs but discards inherited profile-derived override", async () => {
  const options = await fixture();
  expect(resolveProfileContext({ ...options, env: { PI_CODING_AGENT_DIR: "custom-agent" } }).agentDir).toBe(join(options.cwd, "custom-agent"));
  const inheritedAgent = join(options.homeDir, ".omp", "profiles", "audn", "agent");
  expect(resolveProfileContext({ ...options, profile: "default", env: { OMP_PROFILE: "audn", PI_CODING_AGENT_DIR: inheritedAgent } }).agentDir).toBe(join(options.homeDir, ".omp", "agent"));
  expect(resolveProfileContext({ ...options, env: { OMP_PROFILE: "", PI_PROFILE: "audn", PI_CODING_AGENT_DIR: inheritedAgent } }).agentDir).toBe(join(options.homeDir, ".omp", "agent"));
  expect(resolveProfileContext({ ...options, env: { OMP_CONFIG_DIR: ".ignored" } }).baseConfigRoot).toBe(join(options.homeDir, ".omp"));
});

test("XDG data, state and cache resolve independently only for existing profile paths", async () => {
  const options = await fixture();
  const dataHome = join(options.homeDir, "data"); const stateHome = join(options.homeDir, "state"); const cacheHome = join(options.homeDir, "cache");
  await mkdir(join(dataHome, "omp"), { recursive: true });
  await mkdir(join(stateHome, "omp", "profiles", "audn"), { recursive: true });
  await mkdir(join(cacheHome, "omp", "profiles", "audn"), { recursive: true });
  const env = { XDG_DATA_HOME: dataHome, XDG_STATE_HOME: stateHome, XDG_CACHE_HOME: cacheHome };
  expect(resolveProfileContext({ ...options, env }).sessionsDir).toBe(join(dataHome, "omp", "sessions"));
  const named = resolveProfileContext({ ...options, env, profile: "audn" });
  expect(named.dataDir).toBe(join(options.homeDir, ".omp", "profiles", "audn", "agent"));
  expect(named.stateDir).toBe(join(stateHome, "omp", "profiles", "audn"));
  expect(named.cacheDir).toBe(join(cacheHome, "omp", "profiles", "audn"));
  expect(named.configFile).toBe(join(options.homeDir, ".omp", "profiles", "audn", "agent", "config.yml"));
  expect(resolveProfileContext({ ...options, env, profile: "other" }).cacheDir).toBe(join(options.homeDir, ".omp", "profiles", "other", "agent"));
});

test("config fallback and ordered overlays resolve without reading settings or credentials", async () => {
  const options = await fixture(); const agentDir = join(options.homeDir, ".omp", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "config.yaml"), "not parsed by this path resolver");
  const context = resolveProfileContext({ ...options, env: { PI_CONFIG_FILES: "first.yml:~/global.yml" }, extraArgs: ["--config", "second.yml", "--config=third.yml"] });
  expect(context.configFile).toBe(join(agentDir, "config.yaml"));
  expect(context.configPaths).toEqual([join(agentDir, "config.yml"), join(agentDir, "config.yaml")]);
  expect(context.projectConfigFile).toBe(join(options.cwd, ".omp", "config.yml"));
  expect(context.overlayConfigPaths).toEqual([join(options.cwd, "first.yml"), join(options.homeDir, "global.yml"), join(options.cwd, "second.yml"), join(options.cwd, "third.yml")]);
  await writeFile(join(agentDir, "config.yml"), "canonical file");
  expect(resolveProfileContext(options).configFile).toBe(join(agentDir, "config.yml"));
});

test("registry includes default and safe existing profiles only, including migrated XDG profiles", async () => {
  const options = await fixture(); const root = join(options.homeDir, ".omp", "profiles"); const dataHome = join(options.homeDir, "data");
  await mkdir(join(root, "audn"), { recursive: true });
  await mkdir(join(root, "UPPER")); await mkdir(join(root, "con"));
  await writeFile(join(root, "not-a-directory"), "file");
  await symlink(join(root, "audn"), join(root, "linked"), "dir");
  await mkdir(join(dataHome, "omp", "profiles", "abliteration"), { recursive: true });
  const contexts = await listProfileContexts({ ...options, env: { XDG_DATA_HOME: dataHome } });
  expect(contexts.map(context => context.label)).toEqual(["default", "abliteration", "audn"]);
  expect(contexts[2]).toMatchObject({ profile: "audn", source: "setting", launchProfile: "audn", exists: true });
  expect(resolveProfileContext({ ...options, profile: "new-profile" }).exists).toBe(false);
});

test("Windows resolution matches native path rules and does not enable XDG", () => {
  const context = resolveProfileContext({ homeDir: "C:\\Users\\Example", cwd: "C:\\work", platform: "win32", env: { XDG_DATA_HOME: "C:\\data" }, profile: "audn" });
  expect(context.agentDir).toBe("C:\\Users\\Example\\.omp\\profiles\\audn\\agent");
  expect(context.sessionsDir).toBe("C:\\Users\\Example\\.omp\\profiles\\audn\\agent\\sessions");
});

test("session storage and launch cwd overrides have separate persistence keys", async () => {
  const options = await fixture();
  const standard = resolveProfileContext(options);
  const custom = resolveProfileContext({ ...options, extraArgs: ["--session-dir", "custom-sessions"] });
  expect(custom.sessionsDir).toBe(join(options.cwd, "custom-sessions"));
  expect(custom.key).not.toBe(standard.key);
  const moved = resolveProfileContext({ ...options, extraArgs: ["--cwd", "../other-workspace"] });
  expect(moved.cwd).toBe(join(options.homeDir, "other-workspace"));
  expect(moved.key).not.toBe(standard.key);
});

test("launch context stripping removes actual cwd/profile flags without changing literals", () => {
  expect(stripLaunchContextArgs(["--cwd", "../workspace", "--profile=audn", "--config", "overlay.yml"])).toEqual(["--config", "overlay.yml"]);
  expect(stripLaunchContextArgs(["--system-prompt", "--cwd", "literal", "--", "--cwd=literal", "--profile=literal"])).toEqual(["--system-prompt", "--cwd", "literal", "--", "--cwd=literal", "--profile=literal"]);
  expect(stripLaunchContextArgs(["--cwd", "--profile", "literal"])).toEqual(["literal"]);
  expect(stripLaunchContextArgs(["--plan", "--cwd=../workspace", "prompt"])).toEqual(["--plan", "--omp-profile-boundary", "prompt"]);
  expect(stripLaunchContextArgs(["models", "--cwd", "literal", "--profile=literal"])).toEqual(["models", "--cwd", "literal", "--profile=literal"]);
});
