import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let cancelled = false;

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: 1,
      agentCapabilities: { loadSession: true }, authMethods: [{ id: "cursor_login" }] } });
  } else if (message.method === "authenticate") {
    send({ id: message.id, result: {} });
  } else if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "fixture-session", modes: {
      currentModeId: "agent", availableModes: [{ id: "ask", name: "Ask" }] } } });
  } else if (message.method === "session/load" || message.method === "session/set_mode") {
    send({ id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    const text = message.params.prompt[0].text;
    if (text === "HANG") return;
    send({ method: "session/update", params: { sessionId: message.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fixture:${text}` } } } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.method === "session/cancel") {
    cancelled = true;
    setTimeout(() => process.exit(0), 5);
  }
});

process.on("exit", () => { if (cancelled) process.stderr.write("cancelled\n"); });
