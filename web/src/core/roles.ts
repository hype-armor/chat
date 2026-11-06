// Group role rules (ADR-0016). Pure functions, shared by the engine and tests.

import { toHex } from './ids'

/** Splits a `GroupInfo` admin list (16-byte account ids, concatenated). */
export function parseAdmins(flat: Uint8Array): string[] {
  const out: string[] = []
  for (let i = 0; i + 16 <= flat.length; i += 16) out.push(toHex(flat.slice(i, i + 16)))
  return out
}

/** Admins who are still members, in priority order. */
export function activeAdmins(admins: string[] | undefined, members: string[]): string[] {
  return (admins ?? []).filter((a) => members.includes(a))
}

/**
 * Who should commit `leavers`' departure: the first admin still in the
 * group, else the member with the lowest leaf index (`members` is in leaf
 * order). Everyone computes the same answer, so normally exactly one member
 * commits.
 */
export function designatedCommitter(
  admins: string[] | undefined,
  members: string[],
  leavers: string[],
): string | undefined {
  const others = members.filter((m) => !leavers.includes(m))
  return activeAdmins(admins, others)[0] ?? others[0]
}

/**
 * Whether to accept a rename or admin change from `sender`. The first
 * `GroupInfo` a member sees is trusted (that's how newcomers learn the admin
 * list); after that only admins may change it.
 */
export function acceptsGroupInfo(admins: string[] | undefined, sender: string): boolean {
  return admins === undefined || admins.length === 0 || admins.includes(sender)
}

/**
 * Whether a conversation shows the group UI (members, group info) or the
 * direct-chat controls (verify, report, block). A name alone does not make a
 * group: a 1:1 peer can send a `GroupInfo`, and hiding the safety controls
 * behind a rename would help exactly the person they protect against (audit
 * M9). A real group has more than one other person, or a name together with
 * an admin list.
 */
export function isGroupView(conv: { peers: string[]; name?: string; admins?: string[] }): boolean {
  if (conv.peers.length > 1) return true
  return conv.name !== undefined && (conv.admins ?? []).length > 0
}
