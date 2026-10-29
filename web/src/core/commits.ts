// Commit bookkeeping shared by the engine and its tests.

/**
 * Whether the server accepted our commit: it records the hash of the one
 * commit it accepted per epoch. No record (404) means it never saw ours.
 */
export function commitWasAccepted(ourHash: string, serverHash: string | undefined): boolean {
  return serverHash !== undefined && serverHash === ourHash
}
