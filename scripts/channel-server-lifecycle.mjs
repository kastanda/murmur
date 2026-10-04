/**
 * channel-server-lifecycle.mjs — ownership of one MCP channel-server process.
 *
 * A channel server belongs to exactly one MCP client connection. The normal end of that
 * connection is stdin EOF, which the server already handles. This adds the case EOF cannot
 * cover: the owner died while something else (a leaked child, an inherited descriptor) keeps
 * the pipe open, so the server is reparented and would otherwise live forever.
 *
 * Deliberately NOT here: an idle timeout. An MCP client sends nothing after `initialize`, so
 * "idle" is indistinguishable from "a live thread waiting for a message"; exiting then would
 * silently deafen a live session. Ownership loss is the only protocol-safe signal.
 */

/** True when `pid` exists (EPERM still means it exists). */
export const defaultIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

/**
 * Poll the owner. Fires `onOwnerGone(reason)` at most once, when the original parent is no
 * longer our parent (reparented) or no longer exists. Returns `{ stop }`.
 */
export const watchOwner = ({
  originalParentPid = process.ppid,
  getParentPid = () => process.ppid,
  isAlive = defaultIsAlive,
  intervalMs = 5_000,
  onOwnerGone,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) => {
  let fired = false;
  const check = () => {
    if (fired) return;
    const current = getParentPid();
    let reason = null;
    if (current !== originalParentPid) reason = "owner-reparented";
    else if (!isAlive(originalParentPid)) reason = "owner-gone";
    if (!reason) return;
    fired = true;
    clearIntervalImpl(timer);
    onOwnerGone(reason);
  };
  const timer = setIntervalImpl(check, intervalMs);
  timer.unref?.();
  return { stop: () => { fired = true; clearIntervalImpl(timer); }, check };
};
