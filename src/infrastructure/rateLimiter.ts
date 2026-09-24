export interface DomainRateLimiter {
  wait(domain: string): Promise<void>;
}

export function createDomainRateLimiter(delayMs: number): DomainRateLimiter {
  const lastHit = new Map<string, number>();
  return {
    async wait(domain: string): Promise<void> {
      const now = Date.now();
      const prev = lastHit.get(domain) ?? 0;
      const waitFor = prev + delayMs - now;
      if (waitFor > 0) {
        await new Promise((r) => setTimeout(r, waitFor));
      }
      lastHit.set(domain, Date.now());
    },
  };
}
