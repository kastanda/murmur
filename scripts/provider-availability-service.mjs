/**
 * provider-availability-service.mjs — the daemon-side owner of ONE provider's routing availability.
 *
 *   resolve()        synchronous effective availability from durable state (never probes)
 *   resolveFresh()   refreshes provider usage when — and only when — the state asks for it (a stale
 *                    snapshot, or a passed reset), throttled, then resolves
 *   gate()           the pre-launch decision for one claimed dispatch: launch, or defer until reset
 *   observeTurn()    classify a finished turn: a positively identified quota error records EXHAUSTED
 *                    (with its reset), a real success proves availability and clears it
 *
 * Nothing here cancels or interrupts a turn: exhaustion only affects work not yet started.
 */
import {
  AVAILABILITY, availabilityFile, classifyProviderError, clearExhaustion, createAvailabilityReader,
  evidenceFromError, nextCheckAt, recordExhaustion, PROVIDER_REASONS,
} from "./provider-availability.mjs";
import { usageCacheFile } from "./provider-usage.mjs";

/** Never re-read a provider's usage more often than this, however many items are waiting. */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

export const createAvailabilityService = ({
  provider, usageFile = usageCacheFile(), recordFile = availabilityFile(), identities = {},
  refreshUsage = null, now = () => Date.now(), log = () => {},
}) => {
  const reader = createAvailabilityReader({ usageFile, recordFile, identities, now });
  const lastRefresh = new Map();
  const resolve = (name = provider) => reader.resolve(name);

  const resolveFresh = async (name = provider) => {
    let resolution = resolve(name);
    // Only a stale snapshot, a passed reset, or a standing exhaustion warrants a provider read; a provider
    // that exposes no usage at all (Cursor: UNKNOWN, not pending) is never probed.
    // A standing exhaustion with an authoritative FUTURE reset cannot recover before it: no read.
    const needsRefresh = resolution.pendingRefresh
      || (resolution.availability === AVAILABILITY.exhausted && !Number.isFinite(Date.parse(resolution.resetsAt)));
    const last = lastRefresh.get(name) ?? 0;
    if (needsRefresh && typeof refreshUsage === "function" && now() - last >= REFRESH_MIN_INTERVAL_MS) {
      lastRefresh.set(name, now());
      try { await refreshUsage(name); } catch (error) {
        log("warn", "Provider usage refresh failed; availability unchanged", { provider: name, error: String(error?.message ?? error).slice(0, 80) });
      }
      resolution = resolve(name);
    }
    // An authoritative reading (or an expired hold) retires the error-derived record.
    if (resolution.availability !== AVAILABILITY.exhausted && clearExhaustion(recordFile, name, identities[name] ?? null).changed) {
      log("info", "Provider availability recovered", { provider: name, availability: resolution.availability });
    }
    return resolution;
  };

  /** @returns {{ allow: true } | { allow: false, nextAttemptAt: number, resolution: object }} */
  const gate = async (name = provider) => {
    const resolution = await resolveFresh(name);
    if (resolution.eligible) return { allow: true, resolution };
    return { allow: false, resolution, nextAttemptAt: nextCheckAt(resolution, now()) };
  };

  /** Returns the quota classification when the turn failed with authoritative quota evidence. */
  const observeTurn = (name, result) => {
    if (!result) return null;
    if (result.status === "completed" || result.status === "completed-handoff" || result.status === "completed-reply-pending") {
      if (clearExhaustion(recordFile, name, identities[name] ?? null).changed) log("info", "Provider availability recovered by a successful turn", { provider: name });
      return null;
    }
    if (result.status !== "failed" && result.status !== "unknown") return null;
    const evidence = evidenceFromError(result.error);
    const verdict = evidence ? classifyProviderError(name, evidence) : null;
    if (!verdict?.exhausted) return null;
    const { changed, record } = recordExhaustion(recordFile, name, {
      observedAt: new Date(now()).toISOString(), source: verdict.source, resetsAt: verdict.resetsAt, category: verdict.category, identity: identities[name] ?? null,
    });
    if (changed) log("warn", "Provider quota exhausted (authoritative provider error)", { provider: name, category: verdict.category, resetsAt: record.resetsAt });
    return { ...verdict, reason: PROVIDER_REASONS.quotaExhausted };
  };

  return { provider, resolve, resolveFresh, gate, observeTurn, recordFile, usageFile };
};

/**
 * Wrap the runtime dispatcher with the quota gate. Before a claimed dispatch starts anything:
 * an authoritatively EXHAUSTED provider defers it (durably, in `wake_dispatch`) until the reset —
 * no runtime start, no model call, no attempt consumed. After a turn: a positively identified quota
 * error records EXHAUSTED and moves the failed dispatch to the same deferred wait instead of a retry.
 */
export const withQuotaGate = ({ service, executeTurn, dispatchStore, now = () => Date.now(), log = () => {} }) => async (payload, dispatch) => {
  const provider = service.provider;
  const gate = await service.gate(provider);
  if (!gate.allow) {
    dispatchStore.defer(dispatch, PROVIDER_REASONS.quotaExhausted, gate.nextAttemptAt, now());
    log("info", "Dispatch deferred: provider quota exhausted (no runtime started)", {
      msgId: payload?.msgId, provider, resetsAt: gate.resolution.resetsAt, nextAttemptAt: gate.nextAttemptAt,
    });
    return { status: "deferred-provider-quota", provider, resetsAt: gate.resolution.resetsAt };
  }
  let result;
  try {
    result = await executeTurn(payload, dispatch);
  } catch (error) {
    if (service.observeTurn(provider, { status: "failed", error })) {
      dispatchStore.deferForProvider(dispatch, PROVIDER_REASONS.quotaExhausted, nextCheckAt(service.resolve(provider), now()), now());
    }
    throw error;
  }
  if (service.observeTurn(provider, result)) {
    const next = nextCheckAt(service.resolve(provider), now());
    // Only report a wait that really happened: a dispatch that could not be moved keeps its own outcome.
    if (dispatchStore.deferForProvider(dispatch, PROVIDER_REASONS.quotaExhausted, next, now()) !== 1) return result;
    log("warn", "Turn failed on provider quota; work waits for the reset (no retry)", { msgId: payload?.msgId, provider, nextAttemptAt: next });
    return { ...result, status: "deferred-provider-quota" };
  }
  return result;
};
