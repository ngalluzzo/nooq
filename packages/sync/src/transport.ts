/** Transport abstraction — SYNC.md SW-8. The envelope is the contract. */

export interface SyncTransport {
  send(raw: string): void;
  onMessage(handler: (raw: string) => void): void;
  close(): void;
}

/** Drain the loopback network: microtask + timer rounds so relays and sessions settle. */
export async function settled(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
