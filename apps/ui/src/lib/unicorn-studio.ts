type UnicornSceneInstance = {
  destroy?: () => void
  resize?: () => void
}

type UnicornAddSceneConfig = {
  elementId: string
  filePath?: string
  projectId?: string
  fps?: number
  scale?: number
  dpi?: number
  lazyLoad?: boolean
  fixed?: boolean
  disableMobile?: boolean
  production?: boolean
}

type UnicornStudioApi = {
  addScene: (config: UnicornAddSceneConfig) => Promise<UnicornSceneInstance>
}

declare global {
  interface Window {
    UnicornStudio?: UnicornStudioApi
  }
}

const UNICORN_SDK_URL =
  "https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v2.1.5/dist/unicornStudio.umd.js"
const UNICORN_SCRIPT_SELECTOR = 'script[data-unicorn-studio-sdk="true"]'

let sdkPromise: Promise<UnicornStudioApi> | null = null

export function loadUnicornStudio(): Promise<UnicornStudioApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Unicorn Studio is client-only"))
  }

  if (window.UnicornStudio?.addScene) {
    return Promise.resolve(window.UnicornStudio)
  }

  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise<UnicornStudioApi>((resolve, reject) => {
    const resolveIfReady = () => {
      if (window.UnicornStudio?.addScene) {
        resolve(window.UnicornStudio)
      } else {
        sdkPromise = null
        reject(new Error("Unicorn Studio SDK loaded without addScene"))
      }
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      UNICORN_SCRIPT_SELECTOR,
    )
    if (existingScript) {
      if (window.UnicornStudio?.addScene) {
        resolve(window.UnicornStudio)
        return
      }
      existingScript.addEventListener("load", resolveIfReady, { once: true })
      existingScript.addEventListener(
        "error",
        () => {
          sdkPromise = null
          reject(new Error("Failed to load UnicornStudio script from CDN"))
        },
        { once: true },
      )
      return
    }

    const script = document.createElement("script")
    script.src = UNICORN_SDK_URL
    script.async = true
    script.dataset.unicornStudioSdk = "true"
    script.onload = resolveIfReady
    script.onerror = () => {
      sdkPromise = null
      reject(new Error("Failed to load UnicornStudio script from CDN"))
    }
    ;(document.head || document.body).appendChild(script)
  })

  return sdkPromise
}
