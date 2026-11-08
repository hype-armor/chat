import { validContentHash, validReplyId } from './replies'

/** Fixed interoperable picker vocabulary. Empty string is a durable tombstone. */
export const REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const
export type ReactionUpdate = {
  target: string
  hash: string
  author: string
  account: string
  device: string
  at: number
  emoji: string
  /** Worker-only durable evidence that this binding matched a verified original. */
  verified?: boolean
}
export type ReactionOriginal = { id: string; from: string; contentHash?: string; kind?: 'notice' }
export type ReactionChip = { emoji: string; count: number; own: boolean }

export function validReaction(r: ReactionUpdate): boolean {
  return validReplyId(r.target) && validContentHash(r.hash) && validReplyId(r.author) &&
    validReplyId(r.account) && validReplyId(r.device) && Number.isSafeInteger(r.at) && r.at > 0 &&
    (r.emoji === '' || REACTION_EMOJI.some((emoji) => emoji === r.emoji))
}

export function bindingMatches(r: ReactionUpdate, original: ReactionOriginal | undefined, me: string): boolean {
  return !!original && original.kind !== 'notice' && original.id === r.target &&
    validContentHash(original.contentHash) && original.contentHash === r.hash &&
    (original.from === 'me' ? me : original.from) === r.author
}

/** Never use unauthenticated outer envelope IDs to break ordering ties. */
export function newer(a: ReactionUpdate, b: ReactionUpdate): boolean {
  if (a.at !== b.at) return a.at > b.at
  if (a.device !== b.device) return a.device > b.device
  if (a.emoji === '' || b.emoji === '') return a.emoji === '' && b.emoji !== ''
  return a.emoji > b.emoji
}

export function reactionStates(updates: ReactionUpdate[], original: ReactionOriginal, me: string): ReactionUpdate[] {
  const states = new Map<string, ReactionUpdate>()
  for (const update of updates) {
    if (!validReaction(update) || update.target !== original.id) continue
    // A verified durable anchor permits removal, not new reactions to unverifiable content.
    const verified = bindingMatches(update, original, me)
    if (!verified && !update.verified) continue
    if ((original.from === 'me' ? me : original.from) !== update.author) continue
    if (validContentHash(original.contentHash) && original.contentHash !== update.hash) continue
    const previous = states.get(update.account)
    if (!previous || newer(update, previous)) states.set(update.account, update)
  }
  return [...states.values()]
}

export function reactionChips(states: ReactionUpdate[], me: string): ReactionChip[] {
  const chips = new Map<string, ReactionChip>()
  for (const state of states) {
    if (!state.emoji) continue
    const chip = chips.get(state.emoji) ?? { emoji: state.emoji, count: 0, own: false }
    chip.count++
    chip.own ||= state.account === me
    chips.set(state.emoji, chip)
  }
  return REACTION_EMOJI.flatMap((emoji) => chips.get(emoji) ?? [])
}
