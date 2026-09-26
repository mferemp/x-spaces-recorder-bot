import { renderToString } from 'react-dom/server'

export function render() {
  return renderToString(
    <div
      data-app-placeholder
      style={{
        minHeight: '100vh',
        background: '#ffffff',
      }}
    />
  )
}
