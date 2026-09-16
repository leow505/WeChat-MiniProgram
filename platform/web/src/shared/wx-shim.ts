/**
 * A browser-shaped `wx` storage object.
 *
 * The shared dictionary module reads and writes the chosen locale through
 * `wx.getStorageSync` / `wx.setStorageSync`, and reads the device language from
 * `wx.getAppBaseInfo`. Those are the only WeChat APIs anywhere in the shared
 * modules — the rule and money modules are deliberately free of them.
 *
 * Providing the three functions is therefore enough to reuse the dictionaries
 * verbatim, which is much better than maintaining a second set of translations
 * that would slowly disagree with the mini program's.
 *
 * Must be imported before anything that imports the dictionaries.
 */

interface WxShim {
  getStorageSync(key: string): string
  setStorageSync(key: string, value: string): void
  removeStorageSync(key: string): void
  getAppBaseInfo(): { language: string }
}

declare global {
  var wx: WxShim | undefined
}

const memory = new Map<string, string>()

/** localStorage throws in private mode on some browsers; fall back to memory. */
function readLocal(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return memory.get(key) ?? ''
  }
}

function writeLocal(key: string, value: string): void {
  memory.set(key, value)
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Memory copy already holds it; the choice simply will not outlive the tab.
  }
}

export function installWxShim(): void {
  if (globalThis.wx) return
  globalThis.wx = {
    getStorageSync: readLocal,
    setStorageSync: writeLocal,
    removeStorageSync(key) {
      memory.delete(key)
      try {
        window.localStorage.removeItem(key)
      } catch {
        // Nothing to do.
      }
    },
    getAppBaseInfo() {
      return { language: navigator.language || 'zh_CN' }
    },
  }
}

// Installed as a side effect of importing this module, not by a later call: a
// module body runs before the body of the module that imported it, so the
// dictionaries would otherwise read storage before the shim existed. Import this
// module before anything that reaches for `wx`.
installWxShim()
