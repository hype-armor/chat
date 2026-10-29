// Commit bookkeeping shared by the engine and its tests.

/**
 * Whether the server accepted our commit: it records the hash of the one
 * commit it accepted per epoch. No record (404) means it never saw ours.
 */
export function commitWasAccepted(ourHash: string, serverHash: string | undefined): boolean {
  return serverHash !== undefined && serverHash === ourHash
}

export type CommitOutcome = 'accepted' | 'conflict' | 'rejected' | 'lost'

/** Turns a commit outcome into the error a user sees (none if accepted). */
export function throwUnlessAccepted(outcome: CommitOutcome, action: string) {
  if (outcome === 'accepted') return
  if (outcome === 'lost') throw new Error(`Connection lost while ${action}; this will finish when you are back online`)
  if (outcome === 'conflict') throw new Error('Someone else changed the group at the same moment; try again')
  throw new Error(`Could not finish ${action} right now; try again`)
}
