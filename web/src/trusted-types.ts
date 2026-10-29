// Trusted Types policy (CSP `require-trusted-types-for 'script'`): the only
// script URLs we ever load are our own, so reject anything cross-origin.

type ScriptUrlPolicy = { createScriptURL(url: string): unknown }
type TrustedTypesFactory = {
  createPolicy(name: string, rules: { createScriptURL(url: string): string }): ScriptUrlPolicy
}

const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes

export function sameOriginScriptUrl(url: string, base: string = globalThis.location?.href): string {
  const parsed = new URL(url, base)
  if (parsed.origin !== new URL(base).origin) {
    throw new TypeError(`refusing cross-origin script URL: ${parsed.origin}`)
  }
  return parsed.href
}

// Browsers without Trusted Types (Firefox, Safari today) accept plain strings.
const policy = factory?.createPolicy('chat', { createScriptURL: (url) => sameOriginScriptUrl(url) })

/** A script URL accepted by `new Worker()` and `serviceWorker.register()`. */
export function scriptUrl(url: string): string {
  return (policy ? policy.createScriptURL(url) : sameOriginScriptUrl(url)) as string
}
