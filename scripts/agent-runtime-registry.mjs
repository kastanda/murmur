export class AgentRuntimeRegistry {
  constructor(adapters = []) { this.byKind = new Map(); this.bySlot = new Map(); adapters.forEach((adapter) => this.register(adapter)); }
  register(adapter) {
    if (!adapter?.runtimeKind || !adapter?.memberSlot) throw new Error("runtime-adapter-identity-required");
    if (this.byKind.has(adapter.runtimeKind)) throw new Error(`runtime-adapter-kind-duplicate:${adapter.runtimeKind}`);
    if (this.bySlot.has(adapter.memberSlot)) throw new Error(`runtime-adapter-slot-duplicate:${adapter.memberSlot}`);
    this.byKind.set(adapter.runtimeKind, adapter); this.bySlot.set(adapter.memberSlot, adapter); return adapter;
  }
  getByKind(runtimeKind) { return this.byKind.get(runtimeKind) || null; }
  getByMemberSlot(memberSlot) { return this.bySlot.get(memberSlot) || null; }
  adapters() { return [...this.byKind.values()]; }
  async executeTurn(payload, dispatch) {
    const adapter = this.getByMemberSlot(dispatch?.memberSlot);
    if (!adapter) throw new Error(`runtime-adapter-unavailable:${dispatch?.memberSlot || "unknown"}`);
    return adapter.executeTurn(payload, dispatch);
  }
  health() { return this.adapters().map((adapter) => adapter.health()); }
  async recoverCompletedReplies() { return Promise.all(this.adapters().map((adapter) => adapter.recoverCompletedReplies?.())); }
  async cancelAll() { return Promise.all(this.adapters().filter((adapter) => adapter.capabilities.cancel).map((adapter) => adapter.cancel())); }
  async shutdownAll() { return Promise.all(this.adapters().map((adapter) => adapter.shutdown())); }
}
