# ADR-0027: Live location as ordinary messages, kept to the latest point

- **Status:** Accepted
- **Date:** 2026-10-30
- **Deciders:** project owner, Claude
- **Related requirements:** FR-LOC-2, FR-LOC-3, FR-LOC-6
- **Changes:** doc 06 §2 (server-side coalescing dropped)

## Context
Doc 06 §2 planned live updates as *ephemeral* messages that the server
would coalesce: it would keep only the newest queued update per session,
with a short TTL, so a phone coming back online would not get a flood of
stale points.

MLS application messages are encrypted under a per-sender ratchet that
advances with every message. A receiver can skip ahead only a bounded number
of generations: OpenMLS's `maximum_forward_distance`, 1000 by default. If
the server throws away updates, a member who was offline through a long
session can face a gap larger than that. Every later message from that
sender in the epoch then fails to decrypt, including ordinary texts.

## Options considered
1. **Server coalescing as planned, plus a commit (new epoch) when each
   session ends**, so gaps can't outlive a session. More moving parts, an
   MLS commit per session, and an 8 h session can still exceed the bound if
   updates are frequent.
2. **Raise `maximum_forward_distance`.** It postpones the problem rather
   than removing it, and widens how far any member can make others ratchet.
3. **Deliver every update; receivers keep only the latest point.** No
   server change and no ratchet gaps. An offline phone catches up on a
   backlog of small messages.

## Decision
Option 3.

- **Messages:** a `LiveLocation` content body holds:
  - a 16-byte session id;
  - when it ends;
  - a point, absent in a stop message;
  - `stopped`.

  The first message starts the session and shows as a card in the
  conversation. Later ones move its pin and are not shown or counted as
  unread. Only the session's own sender can move or stop it.
- **Durations:** 15 min, 1 h or 8 h. Receivers refuse ends more than
  8 h (+5 min of clock slack) after the message's send time.
- **Rate:**
  - at most one update per 10 s, sooner only after moving 20 m, and a
    heartbeat every 60 s;
  - nothing is sent while offline: queued points would arrive stale, and
    the next live fix replaces them anyway;
  - so a session sends at most 2,880 small updates (≈1 MB over 8 h), and a
    phone catching up decrypts and discards the stale ones;
  - updates and stops are `silent`: no Web Push.
- **Sender:**
  - the page watches the position (`watchPosition`) while any session runs
    and gives each fix to the core worker, which applies the rate rules;
  - the worker keeps the latest fix and re-checks every 15 s. Browsers
    report only changes, so a move held back by the 10 s floor, and the
    heartbeat, go out from there;
  - a banner stays on screen while sharing, with the time left, a Stop
    button and "Sharing pauses while the app is closed" (FR-LOC-6; the web
    limitation in doc 06 §2);
  - sessions end on Stop, at expiry, or on leaving the group.
- **Receivers keep only the latest point,** never a trail. When the session
  ends (stop or expiry), the point is deleted from the stored message and
  the card reads "Live location ended". Expired points are hidden at once
  and deleted by a 15 s sweep.

## Consequences
- **No server change.** Live updates cost queue rows like other small
  messages, deleted on delivery.
- **Catch-up backlog:** a phone offline for a whole 8 h session catches up
  on up to a few thousand tiny messages. That's acceptable at our scale.
  Revisit (option 1) if sessions or groups grow.
- **Per-device:** this device's sessions survive reloads (state is
  persisted), and the page resumes watching when it opens. Linked devices
  of the sender each run their own sessions.
- **Background sharing** needs the native wrappers (doc 06 §2).

## Validation
- **Unit tests:** distance, rate rules and plausible session ends.
- **Browser test:**
  - a 15 min session shows the banner and a card for the other member;
  - moving the sender (Playwright geolocation) moves the receiver's point
    after the rate floor;
  - Stop removes the banner, and both cards read "Live location ended".
