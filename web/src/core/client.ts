import { scriptUrl } from '../trusted-types'
import type { BenchResult, CoreRequest, CoreResponseBody, CoreStatus, ResponseEnvelope } from './protocol'
import workerUrl from './worker.ts?worker&url'

/** The subset of `Worker` the client uses, so tests can substitute a fake. */
export interface WorkerLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent<ResponseEnvelope>) => void): void
}

/** Promise-based access to the core worker. */
export class CoreClient {
  private nextId = 1
  private pending = new Map<number, (body: CoreResponseBody) => void>()

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', ({ data }) => {
      const resolve = this.pending.get(data.id)
      if (resolve) {
        this.pending.delete(data.id)
        resolve(data.body)
      }
    })
  }

  static start(): CoreClient {
    return new CoreClient(new Worker(scriptUrl(workerUrl), { type: 'module' }))
  }

  async status(): Promise<CoreStatus> {
    const body = await this.call({ type: 'status' })
    if (body.type !== 'status') throw unexpected(body)
    return body.status
  }

  async bench(members: number): Promise<BenchResult> {
    const body = await this.call({ type: 'bench', members })
    if (body.type !== 'bench') throw unexpected(body)
    return body.result
  }

  private call(request: CoreRequest): Promise<CoreResponseBody> {
    const id = this.nextId++
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.worker.postMessage({ id, request })
    })
  }
}

function unexpected(body: CoreResponseBody): Error {
  return new Error(body.type === 'error' ? body.message : `unexpected response: ${body.type}`)
}
