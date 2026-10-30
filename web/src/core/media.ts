// Call media encryption in the core worker (ADR-0030). The page hands this
// worker each sender's and receiver's encoded frames, through
// RTCRtpScriptTransform or (Chromium) transferred encoded streams; frames
// are SFrame-encrypted here, so call keys never reach the page.

/** What the page says about a transform. */
export type MediaTransformOptions = {
  conversationId: string
  callId: string
  direction: 'send' | 'receive'
  kind: 'audio' | 'video'
}

/**
 * Leading bytes of a frame left readable for the packetizer (authenticated
 * by SFrame all the same). Calls use VP8, whose payload header the
 * receiver's depacketizer reads: 10 bytes on key frames, 3 otherwise.
 * Audio (Opus) is encrypted whole.
 */
export function clearBytes(kind: 'audio' | 'video', frameType: string | undefined, length: number): number {
  if (kind === 'audio') return 0
  return Math.min(length, frameType === 'key' ? 10 : 3)
}

type EncodedFrame = { data: ArrayBuffer; type?: string }

/** Encrypts or decrypts each frame with `seal`; frames that fail are dropped. */
export function frameTransform(
  options: MediaTransformOptions,
  seal: (data: Uint8Array, clear: number) => Uint8Array,
): TransformStream<EncodedFrame, EncodedFrame> {
  return new TransformStream({
    transform(frame, controller) {
      const data = new Uint8Array(frame.data)
      try {
        const out = seal(data, clearBytes(options.kind, frame.type, data.length))
        frame.data = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
        controller.enqueue(frame)
      } catch {
        // Undecryptable (another call, a stale epoch) or unencryptable: never pass it on in the clear.
      }
    },
  })
}
