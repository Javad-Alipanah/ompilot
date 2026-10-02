import { expect, test } from "bun:test";
import { preview } from "../src/omp/toolPaths";
import { chatMessagesFromOmp } from "../src/omp/sessionHistory";

test("expanded tool output keeps the final line of long results", () => {
  const output = "line\n".repeat(1000) + "FINAL_RESULT_42";
  expect(preview(output)).toContain("FINAL_RESULT_42");
});

test("restored tool calls keep full edit contents and results", () => {
  const content = "const value = 1;\n".repeat(100) + "FINAL_EDIT_MARKER";
  const output = "result\n".repeat(100) + "FINAL_TOOL_MARKER";
  const messages = chatMessagesFromOmp([
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "sample.ts", content } }] },
    { role: "toolResult", toolCallId: "t1", toolName: "write", content: [{ type: "text", text: output }] },
  ]);
  const tool = messages.flatMap((message) => message.parts).find((part) => part.kind === "tool");
  expect(tool?.kind === "tool" && tool.inputPreview).toContain("FINAL_EDIT_MARKER");
  expect(tool?.kind === "tool" && tool.outputPreview).toContain("FINAL_TOOL_MARKER");
});
