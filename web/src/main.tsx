import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/noto-sans/400.css'
import '@fontsource/noto-sans/500.css'
import '@fontsource/noto-sans/700.css'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '@fontsource/noto-sans-sc/700.css'
import './index.css'
import App from './App.tsx'

const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'

function lockMobileViewportScale() {
  const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  if (!viewportMeta) return

  const applyViewport = () => {
    if (viewportMeta.content !== VIEWPORT_CONTENT) {
      viewportMeta.content = VIEWPORT_CONTENT
    }

    const scale = window.visualViewport?.scale ?? 1
    if (Math.abs(scale - 1) < 0.01) return

    viewportMeta.content = 'width=device-width, initial-scale=1, viewport-fit=cover'
    requestAnimationFrame(() => {
      viewportMeta.content = VIEWPORT_CONTENT
    })
  }

  applyViewport()
  window.addEventListener('pageshow', applyViewport)
  window.addEventListener('orientationchange', applyViewport)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) applyViewport()
  })
}

lockMobileViewportScale()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
