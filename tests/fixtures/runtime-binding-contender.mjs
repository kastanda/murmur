import { RuntimeBindingStore } from "../../scripts/runtime-binding-store.mjs";

const [dbPath, identityJson, routeJson, nowText] = process.argv.slice(2);
const store = new RuntimeBindingStore(dbPath);

process.send?.({ type: "ready", pid: process.pid });
process.on("message", (message) => {
  if (message !== "start") return;
  try {
    const result = store.assignDispatch(JSON.parse(identityJson), JSON.parse(routeJson), Number(nowText));
    process.send?.({ type: "result", result });
  } catch (err) {
    process.send?.({ type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    store.close();
    process.disconnect?.();
  }
});
