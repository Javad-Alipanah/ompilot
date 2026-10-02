import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpRpcClient } from "../src/omp/rpcClient";

const directories: string[] = [];
const clients: OmpRpcClient[] = [];
const executablePaths = new WeakMap<OmpRpcClient, string>();
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "omp-client-test-"));
  directories.push(dir);
  const executable = join(dir, "omp");
  await writeFile(executable, `#!${process.execPath}\nimport readline from 'node:readline';\nconst output = value => process.stdout.write(JSON.stringify(value)+'\\n');\noutput({type:'ready',supportedProtocolVersions:[1,2],maxFrameBytes:1048576,maxReassembledFrameBytes:67108864});\nconst input=readline.createInterface({input:process.stdin});\ninput.on('line', line=>{const cmd=JSON.parse(line);if(cmd.type==='negotiate_protocol'){output({type:'response',id:cmd.id,command:cmd.type,success:true,data:{protocolVersion:2}});return;}\nif(cmd.type==="set_ask_dialog"){output({type:"response",id:cmd.id,command:cmd.type,success:true,data:{enabled:cmd.enabled}});return;}\n${body}\n});\ninput.on('close',()=>process.exit(0));\n`);
  await chmod(executable, 0o755);
  const client = new OmpRpcClient({ ompPath: executable, cwd: dir });
  executablePaths.set(client, executable);
  clients.push(client);
  return client;
}

describe("OMP RPC process transport", () => {
  test("launches rpc-ui and correlates concurrent responses by string IDs", async () => {
    const client = await fixture(`setTimeout(()=>output({type:'response',id:cmd.id,command:cmd.type,success:true,data:{idType:typeof cmd.id,args:process.argv,value:cmd.value}}), cmd.value===1?30:1);`);
    await client.start();
    const [first, second] = await Promise.all([
      client.request({ type: "echo", value: 1 }), client.request({ type: "echo", value: 2 }),
    ]);
    expect(first.data).toMatchObject({ idType: "string", value: 1 });
    expect(second.data).toMatchObject({ value: 2 });
    expect((first.data as any).args).toContain("rpc-ui");
  });

  test("unknown response IDs never resolve a different request with the same command", async () => {
    const client = await fixture(`output({type:'response',id:'obsolete',command:cmd.type,success:true,data:{wrong:true}});setTimeout(()=>output({type:'response',id:cmd.id,command:cmd.type,success:true,data:{correct:true}}),10);`);
    await client.start();
    expect((await client.request({ type: "echo" })).data).toEqual({ correct: true });
  });

  test("delivers reconstructed chunked responses to their original request", async () => {
    const client = await fixture(`const bytes=Buffer.from(JSON.stringify({type:'response',id:cmd.id,command:cmd.type,success:true,data:{text:'🌱'.repeat(300000)}}));const count=Math.ceil(bytes.length/262144);for(let index=0;index<count;index++)output({type:'rpc_chunk',chunkId:'large',index,count,byteLength:bytes.length,data:bytes.subarray(index*262144,(index+1)*262144).toString('base64')});`);
    await client.start();
    const response = await client.request({ type: "large" });
    expect((response.data as any).text).toBe("🌱".repeat(300_000));
  });

  test("closes with EOF, rejects outstanding requests and allows restart", async () => {
    const client = await fixture(`if(cmd.type==='shutdown')output({type:'notice',message:'INVALID SHUTDOWN'});`);
    const events: string[] = [];
    client.on("event", event => events.push(String(event.message ?? "")));
    await client.start();
    const outstanding = client.request({ type: "wait" }).catch(error => error.message);
    await client.dispose();
    expect(await outstanding).toMatch(/disposed|exited/i);
    expect(events).not.toContain("INVALID SHUTDOWN");
    await client.start();
    expect(client.isReady).toBe(true);
  });

  test("spawn failure does not crash an unobserved error emitter and can retry", async () => {
    const working = await fixture("");
    const options = { ompPath: "/not/an/executable/omp", cwd: tmpdir() };
    const client = new OmpRpcClient(options);
    clients.push(client);
    await expect(client.start()).rejects.toThrow();
    options.ompPath = executablePaths.get(working)!;
    await client.start();
    expect(client.isReady).toBe(true);
  });

  test("corrupt transport rejects affected requests and recovers for the next command", async () => {
    const client = await fixture(`if(cmd.type==='corrupt')output({type:'rpc_chunk',chunkId:'bad',index:0,count:2,byteLength:1100000,data:'%%%'});else output({type:'response',id:cmd.id,command:cmd.type,success:true,data:{recovered:true}});`);
    await client.start();
    await expect(client.request({ type: "corrupt" })).rejects.toThrow(/Invalid OMP RPC frame/);
    expect((await client.request({ type: "echo" })).data).toEqual({ recovered: true });
  });

  test("concurrent starts share one process and dispose cancels startup promptly", async () => {
    const client = await fixture(`output({type:'response',id:cmd.id,command:cmd.type,success:true,data:{pid:process.pid}});`);
    await Promise.all([client.start(), client.start()]);
    const firstPid = (await client.request({ type: "pid" })).data;
    await client.start();
    expect((await client.request({ type: "pid" })).data).toEqual(firstPid);
    await client.dispose();
    const starting = client.start().catch(error => error.message);
    await client.dispose();
    expect(await starting).toMatch(/before ready/);
    await client.start();
    expect(client.isReady).toBe(true);
  });
});
