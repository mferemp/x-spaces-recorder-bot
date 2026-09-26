const fs = require('fs')
const path = require('path')
const express = require('express')
const { migrate } = require('./lib/db')

migrate()

const app = express()
app.disable('x-powered-by')
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
app.use(express.json({ limit: '2mb' }))

const routesDir = path.join(__dirname, 'routes')
for (const file of fs.readdirSync(routesDir).sort()) {
  if (!file.endsWith('.js')) continue
  const mount = '/api/' + file.replace(/\.js$/, '')
  const router = require(path.join(routesDir, file))
  app.use(mount, router)
  console.log(`[server] mounted ${mount}`)
}

const clientDir = path.join(__dirname, '..', 'frontend', 'dist', 'client')
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(clientDir, 'index.html'), (err) => {
      if (err) next()
    })
  })
}

const port = Number(process.env.BACKEND_PORT || process.env.PORT || 3001)
const host = process.env.HOST || '0.0.0.0'
app.listen(port, host, () => {
  console.log(`[server] listening on http://127.0.0.1:${port}`)
})
