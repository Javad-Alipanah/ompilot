import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { OmpRpcClient } from "../src/omp/rpcClient";
import { listProfileContexts, normalizeProfileName, resolveProfileContext } from "../src/omp/profiles";
import { resolveOmpPath } from "../src/omp/runtimePath";

// Opt-in, no-prompt verification. Own processes/workspaces only; no resume,
// global configuration edits, credentials inspection or model requests.
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const ompPath = resolveOmpPath(option("omp") ?? "omp");
const profiles = (option("profiles")?.split(",").filter(Boolean) ?? (await listProfileContexts()).map(profile => profile.label)).map(profile => normalizeProfileName(profile) ?? "default");
const root = resolve(option("workspace") ?? "work/omp-profiles-smoke");
const output = resolve(option("output") ?? "work/verification/profiles-live.json");
const inside = (file: string, directory: string) => {
  const value = relative(directory, file);
  return !isAbsolute(value) && !value.split(sep).includes("..");
};
const results: Record<string, unknown>[] = [];
for (const profile of profiles) {
  const workspace = resolve(root, `${Date.now()}-${profile}`);
  await mkdir(workspace, { recursive: true });
  const context = resolveProfileContext({ profile, cwd: workspace });
  const client = new OmpRpcClient({ ompPath, cwd: workspace, profile, continueLastSession: false, extraArgs: ["--no-title", "--max-time", "60"] });
  const eventTypes = new Set<string>();
  let stderrBytes = 0;
  client.on("event", event => eventTypes.add(event.type));
  client.on("stderr", value => { stderrBytes += Buffer.byteLength(value); });
  const timer = setTimeout(() => { void client.dispose(); }, 65_000);
  const started = Date.now();
  try {
    await client.start();
    const state = await client.getState();
    const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
    const model = state.model as { provider?: string; id?: string } | undefined;
    if (!sessionFile || !inside(sessionFile, context.sessionsDir)) throw new Error("session-storage-mismatch");
    results.push({ profile, ready: true, durationMs: Date.now() - started, expectedStorage: context.sessionsDir,
      sessionFile, storageMatches: true, model: model ? `${model.provider ?? ""}/${model.id ?? ""}` : undefined,
      thinking: state.thinkingLevel, promptsSent: 0, stderrBytes, eventTypes: [...eventTypes].sort() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ profile, ready: false, durationMs: Date.now() - started, expectedStorage: context.sessionsDir,
      failure: message === "session-storage-mismatch" ? message : /timeout|timed out/i.test(message) ? "startup-timeout" : /exited/i.test(message) ? "process-exited" : "startup-or-state-error",
      promptsSent: 0, stderrBytes, eventTypes: [...eventTypes].sort() });
  } finally {
    clearTimeout(timer);
    await client.dispose();
  }
}
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify({ ompPath, promptsSent: 0, results }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ output, profiles: results.map(result => ({ profile: result.profile, ready: result.ready, storageMatches: result.storageMatches })) }) + "\n");
if (results.some(result => result.ready !== true)) process.exitCode = 1;
