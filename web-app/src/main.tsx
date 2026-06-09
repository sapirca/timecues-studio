import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { IS_STATIC_DEMO } from './state/staticDemo'
import { setIsDemo } from './state/demoFlag'

// Static Cloudflare mirror has no backend, so force every visitor into Demo
// Mode before the first render: reads resolve to the bundled static files and
// writes go to localStorage, and AppShell's auth gate is never tripped.
if (IS_STATIC_DEMO) setIsDemo(true)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
