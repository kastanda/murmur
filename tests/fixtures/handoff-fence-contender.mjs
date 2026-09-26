/**
 * A separate PROCESS holding a stale runtime-binding fence, attempting an authoritative
 * handoff mutation through its own SQLite connection.
 *
 * Released by a barrier so the parent can replace the binding generation first. This is
 * the honest test of the fenced boundary: two real connections, two real processes, one
 * real database, no mocked fence.
 */
import { AgentHandoffStore } from "../../scripts/agent-handoff-store.mjs";

const [dbPath, operationJson] = process.argv.slice(2);
const op = JSON.parse(operationJson);
const store = new AgentHandoffStore(dbPath);

process.send?.({ type: "ready", pid: process.pid });
process.on("message", (message) => {
  if (message !== "start") return;
  try {
    let result;
    if (op.kind === "create") {
      result = store.fencedCreate({
        fence: op.fence, identity: op.identity, record: op.record, outbox: op.outbox,
      }, op.now);
    } else if (op.kind === "close") {
      result = store.fencedClose({
        fence: op.fence,
        identity: op.identity,
        handoffMsgId: op.handoffMsgId,
        replySenderId: op.replySenderId,
        replyConversationId: op.replyConversationId,
        closedByMessageId: op.closedByMessageId,
      }, op.now);
    } else if (op.kind === "terminate") {
      result = store.fencedTerminate({
        fence: op.fence, identity: op.identity, handoffMsgId: op.handoffMsgId, reason: op.reason,
      }, op.now);
    } else {
      throw new Error(`unknown-operation:${op.kind}`);
    }
    process.send?.({ type: "result", result });
  } catch (err) {
    process.send?.({ type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    store.close();
    process.disconnect?.();
  }
});
