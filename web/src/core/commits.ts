// Commit bookkeeping shared by the engine and its tests.

/**
 * Whether the server accepted our commit: it records the hash of the one
 * commit it accepted per epoch. No record (404) means it never saw ours.
 */
export function commitWasAccepted(ourHash: string, serverHash: string | undefined): boolean {
  return serverHash !== undefined && serverHash === ourHash
}

export type CommitOutcome = 'accepted' | 'conflict' | 'limited' | 'rejected' | 'lost'

/** The server's error code for a rate limit (HTTP 429 semantics). */
export const RATE_LIMITED = 429

/** Back-off before re-sending a rate-limited message: 5 s doubling to 2 min. */
export function retryDelay(attempt: number): number {
  return Math.min(5_000 * 2 ** attempt, 120_000)
}

/** Turns a commit outcome into the error a user sees (none if accepted). */
export function throwUnlessAccepted(outcome: CommitOutcome, action: string) {
  if (outcome === 'accepted') return
  if (outcome === 'lost') throw new Error(`Connection lost while ${action}; this will finish when you are back online`)
  if (outcome === 'conflict') throw new Error('Someone else changed the group at the same moment; try again')
  if (outcome === 'limited') throw new Error('You have added a lot of new people recently; try again later')
  throw new Error(`Could not finish ${action} right now; try again`)
}

/** Automatic re-sends of a transient failure before giving up (~10 minutes). */
export const MAX_SEND_RETRIES = 8

/** What the server's answer to a send means for the queued envelope. */
export type SendOutcome = { kind: 'sent' } | { kind: 'retry' } | { kind: 'failed'; reason: string }

/**
 * Accepted, worth trying again (rate limit, server trouble) or refused for
 * good, with a reason a person can act on (FR-MSG-9).
 */
export function sendOutcome(result: { kind: string; accepted?: boolean; errorCode?: number }): SendOutcome {
  if (result.kind === 'send_result') {
    return result.accepted ? { kind: 'sent' } : { kind: 'failed', reason: 'The group changed; try again' }
  }
  switch (result.errorCode) {
    case RATE_LIMITED:
    case 500:
    case 503:
      return { kind: 'retry' }
    case 403:
      return { kind: 'failed', reason: "You're no longer in this conversation" }
    case 400:
      return { kind: 'failed', reason: "The server couldn't accept this message" }
    default:
      return { kind: 'failed', reason: 'The server refused this message' }
  }
}
