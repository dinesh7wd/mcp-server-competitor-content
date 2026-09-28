export interface DomainRateLimiter {
  wait(domain: string): Promise<void>;
}

const PRUNE_THRESHOLD = 1000;

/** Slots are reserved synchronously, so concurrent callers for one domain are spaced out. */
export function createDomainRateLimiter(delayMs: number): DomainRateLimiter {
  const nextSlot = new Map<string, number>();

  const prune = (now: number): void => {
    if (nextSlot.size < PRUNE_THRESHOLD) return;
    for (const [domain, slot] of nextSlot) {
      if (slot + delayMs < now) nextSlot.delete(domain);
    }
  };

  return {
    async wait(domain: string): Promise<void> {
      const now = Date.now();
      prune(now);
      const reserved = nextSlot.get(domain);
      const slot = reserved === undefined ? now : Math.max(now, reserved + delayMs);
      nextSlot.set(domain, slot);
      if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    },
  };
}
