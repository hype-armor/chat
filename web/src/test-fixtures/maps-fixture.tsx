// Synthetic, isolated maps only. No server, account, or real coordinates.
import '../trusted-types'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as maplibre from 'maplibre-gl'
import type { CoreClient } from '../core/client'
import type { ChatMessage, LocationInfo } from '../core/protocol'
import { LocationCard, ShareLocation } from '../ui/Location'
import { LiveCard } from '../ui/Live'
import './maps-fixture.css'

const maps: maplibre.Map[] = []
const originalOn = maplibre.Map.prototype.on
// Test-only observation of real MapView maps. Restore the method after each
// render pass captures a map; tests also restore it before leaving the page.
function observeMaps() {
  maplibre.Map.prototype.on = function (this: maplibre.Map, ...args: Parameters<typeof originalOn>) {
    if (!maps.includes(this)) maps.push(this)
    return originalOn.apply(this, args)
  } as typeof originalOn
}
observeMaps()

// Minimal MVT protobuf encoding for one synthetic place. No fixture download.
function varint(value: number): number[] {
  const bytes: number[] = []
  do {
    const part = value & 127
    value = Math.floor(value / 128)
    bytes.push(part | (value ? 128 : 0))
  } while (value)
  return bytes
}
function bytes(field: number, value: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(value.length), ...value]
}
function text(field: number, value: string): number[] {
  return bytes(field, [...new TextEncoder().encode(value)])
}
function number(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)]
}
function tile(z: number, x: number, y: number): Uint8Array | undefined {
  const n = 2 ** z
  const tx = (1 + 180) / 360 * n
  const ty = (1 - Math.asinh(Math.tan(Math.PI / 180)) / Math.PI) / 2 * n
  if (Math.floor(tx) !== x || Math.floor(ty) !== y) return undefined
  const px = Math.round((tx - x) * 4096)
  const py = Math.round((ty - y) * 4096)
  const keys = ['name', 'kind', 'min_zoom', 'population_rank', 'sort_key']
  const values = ['Synthetic City', 'locality', 1, 15, 1]
  const feature = [
    ...number(1, 1), ...bytes(2, keys.flatMap((_, i) => [i, i])),
    ...number(3, 1), ...bytes(4, [9, ...varint(px * 2), ...varint(py * 2)]),
  ]
  const layer = [
    ...text(1, 'places'), ...bytes(2, feature), ...keys.flatMap((key) => text(3, key)),
    ...values.flatMap((value) => bytes(4, typeof value === 'string' ? text(1, value) : number(4, value))),
    ...number(5, 4096), ...number(15, 2),
  ]
  return new Uint8Array(bytes(3, layer))
}

const core = {
  mapInfo: async () => ({ available: !location.search.includes('no-tiles'), minZoom: 0, maxZoom: 15 }),
  tile: async (z: number, x: number, y: number) => tile(z, x, y),
} as unknown as CoreClient
const initial: LocationInfo = { latitude: 1, longitude: 1, accuracyM: 120 }
const message = { id: 'synthetic-live', from: 'alice' } as ChatMessage

function Fixture() {
  const [point, setPoint] = useState(initial)
  Object.assign(window, { updateMapPoint: setPoint })
  return <>
    <LocationCard core={core} location={initial} />
    <ShareLocation core={core} conversationId="synthetic" trigger={(locate) => <button onClick={locate}>Preview location</button>} onError={console.error} onSend={() => undefined} />
    <LiveCard core={core} conversationId="synthetic" message={message} live={{
      sessionId: 'synthetic', untilStopped: true, expiresAt: Date.now() + 60_000, ended: false,
      latest: { ...point, at: Date.now() },
    }} />
  </>
}
Object.assign(window, { mapFixture: { maps, restore: () => { maplibre.Map.prototype.on = originalOn } } })
createRoot(document.getElementById('root')!).render(<Fixture />)
