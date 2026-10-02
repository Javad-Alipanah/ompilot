import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOmpSessions } from "../src/omp/sessionCatalog";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

test("custom session directories discover direct parent files without leaking nested workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-history-profile-"));
  directories.push(root);
  const cwd = join(root, "project");
  await writeFile(join(root, "parent.jsonl"), JSON.stringify({ type: "session", id: "parent", cwd }) + "\n");
  await writeFile(join(root, "other.jsonl"), JSON.stringify({ type: "session", id: "other", cwd: "/other-workspace" }) + "\n");
  await mkdir(join(root, "parent"));
  await writeFile(join(root, "parent", "worker.jsonl"), JSON.stringify({ type: "session", id: "worker", cwd }) + "\n");
  const sessions = await listOmpSessions(cwd, root, true);
  expect(sessions.map(session => session.id)).toEqual(["parent"]);
  expect((await listOmpSessions(cwd, root)).some(session => session.id === "parent")).toBe(true);
});
