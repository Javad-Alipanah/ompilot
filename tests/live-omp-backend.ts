/** Tests the delivered backend against an explicitly supplied smoke-owned session. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { OmpRpcClient } from "../src/omp/rpcClient";
import { InspectionService } from "../src/omp/inspectionService";

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
if (!options.report || !options.output) throw new Error("Pass --report=<own worker smoke report> --output=<evidence JSON>");
const report = JSON.parse(await readFile(resolve(options.report), "utf8"));
const workspace = resolve(report.workspace);
const sessionFile = resolve(report.initialState.sessionFile);
const within = relative(workspace, sessionFile);
if (within.startsWith("..") || isAbsolute(within)) throw new Error("Session is outside the smoke workspace");
if (!report.children?.length || !report.resumed) throw new Error("Worker smoke report must verify its own session and child");
const client = new OmpRpcClient({ ompPath: options.omp || "omp", cwd: workspace, resumeSessionId: sessionFile, extraArgs: ["--no-title", "--max-time", "60"] });
const service = new InspectionService(client, () => {});
const evidence: Record<string, unknown> = { sessionId: report.initialState.sessionId, assertions: [], success: false };
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); (evidence.assertions as string[]).push(message); };
try {
  await client.start();
  assert(client.isReady, "Delivered client negotiated readiness");
  const state = await client.getState();
  assert(state.sessionId === report.initialState.sessionId, "Delivered client resumed only the supplied smoke-owned session");
  await service.start();
  const snapshot = service.getSnapshot();
  assert(!snapshot.error, "Inspector refreshed without error");
  evidence.agents = snapshot.agents.map((agent) => ({ id: agent.id, kind: agent.kind, status: agent.status, parentId: agent.parentId, canSteer: agent.canSteer, canCancel: agent.canCancel }));
  for (const child of report.children) {
    const worker = snapshot.agents.find((agent) => agent.id === child.id && agent.kind === "worker");
    assert(worker, "Inspector discovered the persisted child after resume");
    assert(!worker!.canSteer && !worker!.canCancel, "Persisted child exposes no live controls");
    await service.select(child.id);
    const transcript = await service.getTranscript(child.id);
    assert(transcript.length === report.resumeChildren.find((entry: any) => entry.id === child.id).persistedMessages, "Inspector owned-path fallback restored every child message");
    evidence.childMessages = transcript.length;
  }
  const advisor = snapshot.agents.find((agent) => agent.kind === "advisor");
  assert(advisor, "Inspector discovered the real advisor sidecar");
  await service.select(advisor!.id);
  const transcript = await service.getTranscript(advisor!.id);
  assert(transcript.length > 0, "Inspector loaded the advisor transcript");
  assert(service.getSnapshot().transcript?.readOnly, "Advisor transcript is explicitly read-only");
  evidence.advisorMessages = transcript.length;
  evidence.success = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  service.dispose();
  await client.dispose();
  const path = resolve(options.output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
}
