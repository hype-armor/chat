// Isolated research prototype. This is not wired to Engine or a real store.
// The adapter must implement the atomicity and isolation contract in the companion document.
export const ACCEPTANCE_STORES = ['mls', 'app', 'history', 'effects', 'ledger'] as const
export type AcceptanceStoreName = typeof ACCEPTANCE_STORES[number]
export type AcceptanceRecord = {
  id: string
  digest: string
  mls: Uint8Array
  app: Uint8Array
  history: Uint8Array
  // Durable intents only. No external action runs in the transaction.
  effects: Uint8Array
}
export type Snapshot = { revision: number; mls: Uint8Array; app: Uint8Array; history: Uint8Array; effects: Uint8Array }
export interface AtomicTransaction {
  readSnapshot(): Promise<Snapshot>
  find(id: string): Promise<string | undefined>
  // Writes all four values and the replay entry as one indivisible commit.
  write(record: AcceptanceRecord, expectedRevision: number): Promise<void>
}
export interface AtomicAcceptanceStore {
  // The adapter must reject the transaction if ANY requested store is not covered.
  transaction<T>(stores: readonly AcceptanceStoreName[], run: (tx: AtomicTransaction) => Promise<T>): Promise<T>
}

// The digest must be a collision-resistant digest of the exact envelope bytes.
// stage must be deterministic and pure. It must not mutate its arguments or do I/O.
export async function acceptAtomically(
  store: AtomicAcceptanceStore,
  id: string,
  digest: string,
  stage: (snapshot: Snapshot) => Omit<AcceptanceRecord, 'id' | 'digest'>,
  ack: () => void,
): Promise<'accepted' | 'duplicate'> {
  if (!id || !digest) throw new Error('Missing delivery identity')
  const result = await store.transaction(ACCEPTANCE_STORES, async tx => {
    const previous = await tx.find(id)
    if (previous !== undefined) {
      if (previous !== digest) throw new Error('Delivery envelope mismatch')
      return 'duplicate' as const
    }
    const snapshot = await tx.readSnapshot()
    const staged = stage(structuredClone(snapshot))
    await tx.write({ id, digest, ...structuredClone(staged) }, snapshot.revision)
    return 'accepted' as const
  })
  // transaction must resolve only after the durable commit, never on request success.
  ack()
  return result
}
