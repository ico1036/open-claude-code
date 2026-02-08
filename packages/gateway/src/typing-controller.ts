/**
 * TypingController - TTL + sealed state based typing indicator lifecycle.
 *
 * Manages chat typing indicators with:
 * - Heartbeat loop (sends typing every intervalMs)
 * - TTL timer (auto-cleanup after ttlMs of inactivity)
 * - Sealed state (prevents late async callbacks from restarting typing)
 * - Two-phase completion: runComplete + dispatchIdle
 */

export type TypingControllerOptions = {
  sendTyping: () => Promise<void> | void;
  intervalMs?: number; // default 4000
  ttlMs?: number; // default 120000
};

export type TypingController = {
  /** Send initial typing + start heartbeat loop + TTL timer */
  start: () => Promise<void>;
  /** Reset TTL timer (call on any agent activity) */
  refresh: () => void;
  /** Signal that the agent run has completed */
  markRunComplete: () => void;
  /** Signal that all dispatched replies have been sent */
  markDispatchIdle: () => void;
  /** Seal + clear all timers. After this, all methods are no-op. */
  cleanup: () => void;
  /** Whether the controller is still actively sending typing indicators */
  isActive: () => boolean;
};

export function createTypingController(opts: TypingControllerOptions): TypingController {
  const { sendTyping, intervalMs = 4000, ttlMs = 120_000 } = opts;

  let sealed = false;
  let runComplete = false;
  let dispatchIdle = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  }

  function tryAutoCleanup() {
    if (runComplete && dispatchIdle) {
      cleanup();
    }
  }

  function resetTtl() {
    if (sealed) return;
    if (ttlTimer) clearTimeout(ttlTimer);
    ttlTimer = setTimeout(() => {
      console.log("[typing-controller] TTL expired, cleaning up");
      cleanup();
    }, ttlMs);
  }

  function cleanup() {
    if (sealed) return;
    sealed = true;
    clearTimers();
  }

  return {
    async start() {
      if (sealed) return;
      try {
        await sendTyping();
      } catch {
        // non-critical
      }
      if (sealed) return; // check again after await
      heartbeatTimer = setInterval(() => {
        if (sealed) return;
        try {
          sendTyping();
        } catch {
          // non-critical
        }
      }, intervalMs);
      resetTtl();
    },

    refresh() {
      if (sealed) return;
      resetTtl();
    },

    markRunComplete() {
      if (sealed) return;
      runComplete = true;
      tryAutoCleanup();
    },

    markDispatchIdle() {
      if (sealed) return;
      dispatchIdle = true;
      tryAutoCleanup();
    },

    cleanup,

    isActive() {
      return !sealed;
    },
  };
}
