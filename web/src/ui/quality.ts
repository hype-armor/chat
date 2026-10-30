// Call quality (FR-CALL-4/8): a coarse rating from WebRTC stats, and the
// video bitrate that goes with it.

export type Quality = 'good' | 'poor'

/** Packet loss above this, or round trips above `POOR_RTT_MS`, make a call "poor". */
const POOR_LOSS = 0.08
const POOR_RTT_MS = 600

export const VIDEO_BITRATE: Record<Quality, number> = { good: 1_500_000, poor: 350_000 }

/** Rates a connection from loss (0–1, what the other side reports) and round-trip time. */
export function rate(loss: number | undefined, rttMs: number | undefined): Quality {
  if ((loss ?? 0) > POOR_LOSS || (rttMs ?? 0) > POOR_RTT_MS) return 'poor'
  return 'good'
}

/** Loss and round-trip time from a peer connection's stats report. */
export function measure(report: RTCStatsReport): { loss?: number; rttMs?: number } {
  let loss: number | undefined
  let rttMs: number | undefined
  report.forEach((s) => {
    if (s.type === 'remote-inbound-rtp' && typeof s.fractionLost === 'number') {
      loss = Math.max(loss ?? 0, s.fractionLost)
    }
    if (s.type === 'candidate-pair' && s.nominated && typeof s.currentRoundTripTime === 'number') {
      rttMs = s.currentRoundTripTime * 1000
    }
  })
  return { loss, rttMs }
}
