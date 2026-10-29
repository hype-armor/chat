// Messages between the UI thread and the core worker.

export type CoreRequest =
  | { type: 'status' }
  | { type: 'bench'; members: number }

export type CoreStatus = { version: string; selfTest: boolean }
export type BenchResult = { members: number; setupMs: number; commitMs: number; commitBytes: number }

export type CoreResponseBody =
  | { type: 'status'; status: CoreStatus }
  | { type: 'bench'; result: BenchResult }
  | { type: 'error'; message: string }

export type RequestEnvelope = { id: number; request: CoreRequest }
export type ResponseEnvelope = { id: number; body: CoreResponseBody }
