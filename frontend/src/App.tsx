import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Radio,
  Download,
  Loader2,
  Square,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  Wand2,
  Info,
  Sparkles,
  Trash2,
  Archive as ArchiveIcon,
  Eye,
  Scissors,
  Play,
  X,
} from 'lucide-react'
import { api } from './lib/api'

type JobStatus = {
  id: string
  state: 'downloading' | 'processing' | 'stopped' | 'ready' | 'error'
  done: number
  total: number
  gaps?: number
  recordedSecs?: number
  totalSecs?: number
  sizeBytes: number
  error: string | null
  name: string
  kind: 'live' | 'replay'
  enhance?: boolean
  elapsedMs: number
  ready: boolean
  groupId?: string
  role?: 'live' | 'backup'
  backup?: 'pending' | 'recording' | 'kept-live' | 'kept-replay' | 'unavailable' | null
}

type MonStatus = {
  id: string
  state: 'watching' | 'recording' | 'ended' | 'error' | 'cancelled'
  attempts: number
  maxAttempts: number
  lastReason: string
  jobId: string | null
  title: string | null
  elapsedMs: number
}

type Rec = {
  id: string
  name: string
  title: string | null
  kind: string
  source: string
  size_bytes: number
  duration_seconds?: number
  enhanced: boolean
  access_mode?: string
  x_connection_id?: string | null
  created_at: string
  available: boolean
}

type Clip = {
  id: string
  parent_recording_id: string
  parent_title: string | null
  parent_name: string | null
  title: string
  start_seconds: number
  end_seconds: number
  duration_seconds: number
  status: string
  format: string
  size_bytes: number
  enhanced: boolean
  created_at: string
  available: boolean
}

type XConnection = {
  id: string
  x_handle: string | null
  display_name: string | null
  avatar_url: string | null
  auth_type: string
  status: string // pending|active|reauth_required|expired|invalid|revoked|disconnected
  granted_scopes: string | null
  connected_at: string | null
  last_validated_at: string | null
  last_used_at: string | null
  encrypted: boolean
  key_managed: boolean
}

// Parse a human timestamp into seconds. Accepts:
//   "90" / "90.5"            → raw seconds
//   "1:30" / "01:30"         → m:ss
//   "1:02:03"                → h:mm:ss
//   "1h 2m 3s" / "2m30s"     → unit form
// Returns null if it can't be understood.
function parseTimestamp(raw: string): number | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  // unit form (h/m/s)
  if (/[hms]/.test(s)) {
    const m = s.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/)
    if (m && (m[1] || m[2] || m[3])) {
      const h = parseFloat(m[1] || '0')
      const mm = parseFloat(m[2] || '0')
      const ss = parseFloat(m[3] || '0')
      return h * 3600 + mm * 60 + ss
    }
    return null
  }
  // colon form
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => p.trim())
    if (parts.some((p) => p === '' || isNaN(Number(p)))) return null
    const nums = parts.map(Number)
    if (nums.length === 2) return nums[0] * 60 + nums[1]
    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
    return null
  }
  // raw seconds
  const n = Number(s)
  return isNaN(n) ? null : n
}

function fmtBytes(b: number) {
  if (!b) return '0 MB'
  const mb = b / 1048576
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB'
  return mb.toFixed(1) + ' MB'
}
function fmtElapsed(ms: number) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':')
}
// Human "audio length" clock from seconds: 3:07 or 1:02:40
function fmtClock(secs: number) {
  const s = Math.max(0, Math.round(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
function fmtDate(iso: string) {  try {
    return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

const CARD = 'rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur p-5'
const INPUT =
  'w-full rounded-xl bg-black/30 border border-white/10 px-4 py-3 text-sm text-white placeholder-white/30 outline-none focus:border-[var(--brand-100,#ff2882)] transition'
const BTN =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed'

// Every network call goes through here so a hung request can NEVER spin forever.
// It aborts after `timeoutMs` and turns network/parse failures into a clear
// message instead of an endless loading state.
async function fetchJson(
  path: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<{ ok: boolean; status: number; data: any }> {
  const { timeoutMs = 25000, ...rest } = opts
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(api(path), { ...rest, signal: ctrl.signal })
    let data: any = {}
    try {
      data = await r.json()
    } catch {
      data = {}
    }
    return { ok: r.ok, status: r.status, data }
  } catch (e: any) {
    if (e?.name === 'AbortError')
      throw new Error('The server took too long to respond. Please try again.')
    throw new Error('Could not reach the server. Check your connection and try again.')
  } finally {
    clearTimeout(t)
  }
}

export default function App() {
  const [spaceLink, setSpaceLink] = useState('')
  const [name, setName] = useState('')
  const [enhance, setEnhance] = useState(true)
  const [accessMode, setAccessMode] = useState<'public' | 'connected_account'>('public')
  const [connections, setConnections] = useState<XConnection[]>([])
  const [showConnect, setShowConnect] = useState(false)

  const [streamUrl, setStreamUrl] = useState('')
  const [showManual, setShowManual] = useState(false)

  const [resolving, setResolving] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const [jobs, setJobs] = useState<JobStatus[]>([])
  const [starting, setStarting] = useState(false)
  const [archive, setArchive] = useState<Rec[]>([])
  const [clips, setClips] = useState<Clip[]>([])
  const [clipFor, setClipFor] = useState<Rec | null>(null)
  const [monitor, setMonitor] = useState<MonStatus | null>(null)
  const [diag, setDiag] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null)
  const [diagOk, setDiagOk] = useState<boolean | null>(null)
  const [diagRunning, setDiagRunning] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const monPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const jobsRef = useRef<JobStatus[]>([])
  const pollBusyRef = useRef(false)

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  // Local 1-second clock: advance the "elapsed" timer for any running job on
  // every tick, independent of the network poll. Without this, the timer only
  // moves when a status poll lands — so a slow or briefly-failing poll makes the
  // whole card look frozen at 00:00:00 even though recording is fine. The server
  // poll still corrects the value; this just keeps it visibly alive.
  const hasRunning = jobs.some(
    (j) => j.state === 'downloading' || j.state === 'processing' || j.state === 'stopped'
  )
  useEffect(() => {
    if (!hasRunning) return
    const t = setInterval(() => {
      setJobs((prev) =>
        prev.map((j) =>
          j.state === 'downloading' || j.state === 'processing' || j.state === 'stopped'
            ? { ...j, elapsedMs: (j.elapsedMs || 0) + 1000 }
            : j
        )
      )
    }, 1000)
    return () => clearInterval(t)
  }, [hasRunning])

  const MAX_CONCURRENT = 3
  const isActive = (s: JobStatus['state']) =>
    s === 'downloading' || s === 'processing' || s === 'stopped'
  // Keep polling a finished live recording while its completion-backup runs, so
  // the card can update if the replay turns out to be more complete.
  const needsPolling = (j: JobStatus) =>
    isActive(j.state) || j.backup === 'pending' || j.backup === 'recording'

  const loadArchive = useCallback(async () => {
    try {
      const r = await fetch(api('space/archive'))
      if (r.ok) setArchive(await r.json())
    } catch {}
  }, [])

  const loadClips = useCallback(async () => {
    try {
      const r = await fetch(api('space/clips'))
      if (r.ok) setClips(await r.json())
    } catch {}
  }, [])

  const loadConnections = useCallback(async () => {
    try {
      const r = await fetch(api('x-connections'))
      if (r.ok) {
        const list: XConnection[] = await r.json()
        setConnections(list)
        // If an account is connected & healthy, default to using it.
        setAccessMode((m) => {
          const hasActive = list.some((c) => c.status === 'active')
          if (hasActive && m === 'public') return 'connected_account'
          if (!hasActive) return 'public'
          return m
        })
      }
    } catch {}
  }, [])

  useEffect(() => {
    loadArchive()
    loadClips()
    loadConnections()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (monPollRef.current) clearInterval(monPollRef.current)
    }
  }, [loadArchive, loadClips, loadConnections])

  const activeConn = connections.find((c) => c.status === 'active') || null
  const anyConn = connections[0] || null

  // Poll ALL active jobs on one interval so several recordings run at once.
  function ensurePolling() {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      // Skip this tick if the previous batch is still in flight — prevents
      // requests stacking up (which makes the whole UI feel laggy/stuck).
      if (pollBusyRef.current) return
      const active = jobsRef.current.filter(needsPolling)
      if (active.length === 0) {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        return
      }
      pollBusyRef.current = true
      try {
        const updates = await Promise.all(
          active.map(async (j) => {
            try {
              const { ok, data } = await fetchJson('space/status/' + j.id, { timeoutMs: 10000 })
              if (ok) return data as JobStatus
            } catch {}
            return null
          })
        )
        let anyJustReady = false
        setJobs((prev) =>
          prev.map((j) => {
            const u = updates.find((x) => x && x.id === j.id)
            if (!u) return j
            if (u.state === 'ready' && j.state !== 'ready') anyJustReady = true
            // Backup finished and we settled on the final copy → refresh archive.
            if (u.backup !== j.backup && (u.backup === 'kept-replay' || u.backup === 'kept-live'))
              anyJustReady = true
            return { ...j, ...u }
          })
        )
        if (anyJustReady) loadArchive()
      } finally {
        pollBusyRef.current = false
      }
    }, 1500)
  }

  function upsertJob(j: JobStatus) {
    setJobs((prev) => [j, ...prev.filter((p) => p.id !== j.id)])
    ensurePolling()
  }

  function dismissJob(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }

  async function startDownload(
    url: string,
    source: 'space' | 'stream',
    src?: { input?: string },
    jobName?: string
  ) {
    setStarting(true)
    setMsg(null)
    const finalName = jobName || name || undefined
    const useConn = accessMode === 'connected_account' && activeConn
    try {
      const { ok, data: d } = await fetchJson('space/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          m3u8: url,
          name: finalName,
          enhance,
          source,
          input: src?.input,
          accessMode: useConn ? 'connected_account' : 'public',
          xConnectionId: useConn ? activeConn!.id : undefined,
        }),
      })
      if (!ok) throw new Error(d.error || 'Failed to start')
      upsertJob({
        id: d.id,
        state: 'downloading',
        done: 0,
        total: 0,
        sizeBytes: 0,
        error: null,
        name: finalName || 'Recording',
        kind: d.kind,
        enhance: d.enhance,
        elapsedMs: 0,
        ready: false,
      })
      // Clear the form so the box is immediately ready for the NEXT Space.
      if (source === 'space') {
        setSpaceLink('')
        setName('')
      } else {
        setStreamUrl('')
      }
      setMsg({
        kind: 'ok',
        text: `Recording started below. The box above is ready — paste another Space link to record another (up to ${MAX_CONCURRENT} at once).`,
      })
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || String(e) })
    } finally {
      setStarting(false)
    }
  }

  async function resolveSpace() {
    if (!spaceLink.trim()) return
    setResolving(true)
    setMsg(null)
    const link = spaceLink.trim()
    const useConn = accessMode === 'connected_account' && activeConn
    try {
      const { data: d } = await fetchJson('space/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: link,
          accessMode: useConn ? 'connected_account' : 'public',
          xConnectionId: useConn ? activeConn!.id : undefined,
        }),
        timeoutMs: 45000,
      })
      if (d.ok && d.m3u8) {
        await startDownload(d.m3u8, 'space', { input: link }, d.title || name || undefined)
      } else {
        setMsg({ kind: 'err', text: d.reason || 'Could not resolve this Space.' })
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || String(e) })
    } finally {
      setResolving(false)
    }
  }

  async function stopJob(id: string) {
    await fetch(api('space/stop/' + id), { method: 'POST' })
  }

  function startMonPolling(id: string) {
    if (monPollRef.current) clearInterval(monPollRef.current)
    monPollRef.current = setInterval(async () => {
      try {
        const r = await fetch(api('space/monitor/' + id))
        if (!r.ok) return
        const m: MonStatus = await r.json()
        setMonitor(m)
        if (m.jobId) {
          // Handoff: monitor found the stream and started a job.
          if (monPollRef.current) clearInterval(monPollRef.current)
          setMsg({ kind: 'ok', text: `Auto-capture caught "${m.title || 'the Space'}" — recording now.` })
          upsertJob({
            id: m.jobId,
            state: 'downloading',
            done: 0,
            total: 0,
            sizeBytes: 0,
            error: null,
            name: m.title || 'Recording',
            kind: 'live',
            elapsedMs: 0,
            ready: false,
          })
          setMonitor(null)
        } else if (m.state === 'error' || m.state === 'cancelled') {
          if (monPollRef.current) clearInterval(monPollRef.current)
        }
      } catch {}
    }, 3000)
  }

  async function startMonitor() {
    if (!spaceLink.trim()) return
    setMsg(null)
    const useConn = accessMode === 'connected_account' && activeConn
    try {
      const { ok, data: d } = await fetchJson('space/monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: spaceLink.trim(),
          accessMode: useConn ? 'connected_account' : 'public',
          xConnectionId: useConn ? activeConn!.id : undefined,
          name: name || undefined,
          enhance,
        }),
        timeoutMs: 30000,
      })
      if (!ok) throw new Error(d.error || 'Failed to start monitor')
      setMonitor({
        id: d.id,
        state: 'watching',
        attempts: 0,
        maxAttempts: 0,
        lastReason: 'Waiting for the Space to become reachable…',
        jobId: null,
        title: null,
        elapsedMs: 0,
      })
      startMonPolling(d.id)
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || String(e) })
    }
  }

  async function cancelMonitor() {
    if (!monitor) return
    await fetch(api('space/monitor/' + monitor.id + '/cancel'), { method: 'POST' })
    if (monPollRef.current) clearInterval(monPollRef.current)
    setMonitor(null)
  }

  async function deleteRec(id: string) {
    await fetch(api('space/archive/' + id), { method: 'DELETE' })
    loadArchive()
  }

  async function deleteClip(id: string) {
    await fetch(api('space/clips/' + id), { method: 'DELETE' })
    loadClips()
  }

  async function validateConn(id: string) {
    try {
      await fetch(api('x-connections/' + id + '/validate'), { method: 'POST' })
    } catch {}
    loadConnections()
  }

  async function disconnectConn(id: string) {
    try {
      await fetch(api('x-connections/' + id), { method: 'DELETE' })
    } catch {}
    loadConnections()
  }

  async function runDiagnostics() {
    if (!spaceLink.trim()) return
    setDiagRunning(true)
    setDiag(null)
    setDiagOk(null)
    setMsg(null)
    const useConn = accessMode === 'connected_account' && activeConn
    try {
      const { data: d } = await fetchJson('space/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: spaceLink.trim(),
          accessMode: useConn ? 'connected_account' : 'public',
          xConnectionId: useConn ? activeConn!.id : undefined,
        }),
        timeoutMs: 40000,
      })
      setDiag(d.steps || [])
      setDiagOk(!!d.ok)
      // If a step failed for want of authenticated access, point the user to
      // connecting an X account.
      if (!d.ok && !activeConn && d.steps?.some((s: any) => !s.ok && /login-restricted|account|authenticate/i.test(s.detail))) {
        setShowConnect(true)
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || String(e) })
    } finally {
      setDiagRunning(false)
    }
  }

  const activeJobs = jobs.filter((j) => isActive(j.state))
  const atCapacity = activeJobs.length >= MAX_CONCURRENT

  const now = Date.now()
  const staleCount = archive.filter(
    (r) => now - new Date(r.created_at).getTime() > 3 * 86400000
  ).length
  const totalBytes = archive.reduce((s, r) => s + (r.size_bytes || 0), 0)

  return (
    <div className="min-h-screen w-full text-white" style={{ background: '#0b0b0f' }}>
      <div
        className="mx-auto max-w-2xl px-4 py-8 md:py-12"
        style={{ paddingTop: 'max(2rem, env(safe-area-inset-top))' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-2xl shrink-0"
            style={{ background: 'var(--brand-100,#ff2882)' }}
          >
            <Radio className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-black tracking-tight leading-tight">
              X Space Recorder
            </h1>
            <p className="text-sm text-white/50">
              Grab the <span className="text-white/80 font-semibold">entire</span> recording — even if you join late.
            </p>
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3 text-xs text-emerald-100/80 leading-relaxed">
          <b className="text-emerald-100">No login needed.</b> Paste a Space link and hit Record —
          it works without signing in. For a <b>live</b> Space, capture starts immediately and pulls
          the buffer from the beginning, so you still get what already aired. Use <b>Stop &amp; save</b>{' '}
          anytime. When the Space ends we automatically grab the <b>complete replay as a backup</b> and
          keep whichever copy is more complete — so you always end up with the full thing.
        </div>

        {/* Clarity toggle */}
        <button
          onClick={() => setEnhance((v) => !v)}
          className="w-full mb-4 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left"
        >
          <Sparkles className="h-5 w-5 text-[var(--brand-100,#ff2882)] shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Audio clarity assurance</div>
            <div className="text-[11px] text-white/45">
              Normalize loudness, clean low-end rumble & re-encode at 192 kbps.
            </div>
          </div>
          <span
            className={
              'relative h-6 w-11 rounded-full transition shrink-0 ' +
              (enhance ? 'bg-[var(--brand-100,#ff2882)]' : 'bg-white/15')
            }
          >
            <span
              className={
                'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ' +
                (enhance ? 'left-[22px]' : 'left-0.5')
              }
            />
          </span>
        </button>

        {/* PRIMARY: Space link */}
        <div className={CARD}>
          <div className="flex items-center gap-2 mb-1">
            <Wand2 className="h-4 w-4 text-[var(--brand-100,#ff2882)]" />
            <h2 className="font-bold">Paste a Space link</h2>
          </div>
          <p className="text-xs text-white/40 mb-4">
            Drop in the Space URL and we'll find its recording and download the whole thing.
          </p>
          <input
            className={INPUT}
            name="spaceLink"
            id="spaceLink"
            autoComplete="off"
            placeholder="https://x.com/i/spaces/1DXGydWQNQNGM"
            value={spaceLink}
            onChange={(e) => setSpaceLink(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className={INPUT + ' mt-3'}
            name="saveAs"
            id="saveAs"
            autoComplete="off"
            placeholder="Save as (optional file name)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className={BTN + ' mt-4 w-full text-white'}
            style={{ background: 'var(--brand-100,#ff2882)' }}
            disabled={!spaceLink.trim() || resolving || starting || atCapacity}
            onClick={resolveSpace}
          >
            {resolving || starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {atCapacity ? `Recording ${activeJobs.length}/${MAX_CONCURRENT} — full` : 'Record now'}
          </button>
          <button
            className={BTN + ' mt-2 w-full text-white'}
            style={{ background: 'rgba(255,255,255,0.08)' }}
            disabled={!spaceLink.trim() || atCapacity || !!monitor}
            onClick={startMonitor}
          >
            <Eye className="h-4 w-4" /> Arm auto-capture (wait &amp; grab the start)
          </button>
          <p className="mt-2 text-[11px] text-white/35 leading-relaxed">
            <b className="text-white/50">Record up to {MAX_CONCURRENT} Spaces at once.</b> Start one,
            then paste another link and hit Record again — each runs in its own panel below.
            <b className="text-white/50"> Auto-capture</b> keeps checking and starts recording the
            instant the Space is reachable — best for a Space that hasn't started yet.
          </p>

          <button
            className={BTN + ' mt-2 w-full'}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.85)' }}
            disabled={!spaceLink.trim() || diagRunning}
            onClick={runDiagnostics}
          >
            {diagRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Info className="h-4 w-4" />
            )}
            {diagRunning ? 'Checking this Space…' : 'Check this Space (diagnostics)'}
          </button>
          <p className="mt-2 text-[11px] text-white/35 leading-relaxed">
            <b className="text-white/50">Not sure it'll work?</b> Run a quick check first — it tests
            every step (find the Space → get the audio → download a real chunk) and tells you exactly
            what's wrong and how to fix it, without starting a recording.
          </p>

          <button
            onClick={() => setShowConnect(true)}
            className="mt-4 inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/70"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            Manage X account connection (Settings)
          </button>

          {diag && (
            <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3 space-y-2">
              {/* Overall verdict */}
              <div
                className={
                  'flex items-start gap-2 rounded-lg px-3 py-2 text-xs font-semibold ' +
                  (diagOk ? 'bg-emerald-500/10 text-emerald-200' : 'bg-amber-500/10 text-amber-200')
                }
              >
                {diagOk ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                )}
                <span>
                  {diagOk
                    ? 'All checks passed — this Space will record. Hit Record now.'
                    : 'Found the problem — see the flagged step below for how to fix it.'}
                </span>
              </div>
              <div className="text-[11px] font-semibold text-white/60 pt-1">Step-by-step</div>
              {diag.map((s, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  {s.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
                  )}
                  <div className="min-w-0">
                    <div className={s.ok ? 'text-white/70' : 'text-amber-200'}>{s.name}</div>
                    <div className="text-white/40 break-words">{s.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Recording access mode selector */}
          <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-white/50 mb-2">
              Recording access mode
            </div>
            <label className="flex items-start gap-2 cursor-pointer py-1.5">
              <input
                type="radio"
                name="accessMode"
                className="mt-1 accent-[var(--brand-100,#ff2882)]"
                checked={accessMode === 'public'}
                onChange={() => setAccessMode('public')}
              />
              <span>
                <span className="text-sm font-medium">Public access</span>
                <span className="block text-[11px] text-white/45">
                  Record publicly accessible Spaces — no X login needed.
                </span>
              </span>
            </label>
            {activeConn ? (
              <label className="flex items-start gap-2 cursor-pointer py-1.5">
                <input
                  type="radio"
                  name="accessMode"
                  className="mt-1 accent-[var(--brand-100,#ff2882)]"
                  checked={accessMode === 'connected_account'}
                  onChange={() => setAccessMode('connected_account')}
                />
                <span>
                  <span className="text-sm font-medium">
                    Connected X account: @{activeConn.x_handle}
                  </span>
                  <span className="block text-[11px] text-white/45">
                    Use this account's authorized access for Spaces that require sign-in.
                  </span>
                </span>
              </label>
            ) : (
              <button
                onClick={() => setShowConnect(true)}
                className="flex items-start gap-2 py-1.5 text-left w-full"
              >
                <span className="mt-1 h-3.5 w-3.5 rounded-full border border-white/30 shrink-0" />
                <span>
                  <span className="text-sm font-medium text-[var(--brand-100,#ff2882)]">
                    Connect an X account
                  </span>
                  <span className="block text-[11px] text-white/45">
                    Authorize this dashboard to use your X account's access. Secure, encrypted, and
                    revocable anytime.
                  </span>
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Message */}
        {msg && (
          <div
            className={
              'mt-4 flex items-start gap-2 rounded-xl px-4 py-3 text-sm ' +
              (msg.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-200' : 'bg-red-500/10 text-red-200')
            }
          >
            {msg.kind === 'ok' ? (
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            )}
            <span>{msg.text}</span>
          </div>
        )}

        {/* Monitor / auto-capture panel */}
        {monitor && (
          <div className={CARD + ' mt-4'}>
            <div className="flex items-center gap-2 mb-3">
              {monitor.state === 'error' ? (
                <AlertTriangle className="h-5 w-5 text-red-400" />
              ) : (
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand-100,#ff2882)] opacity-60" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--brand-100,#ff2882)]" />
                </span>
              )}
              <span className="font-bold">
                {monitor.state === 'error' ? 'Auto-capture stopped' : 'Armed — watching for the Space'}
              </span>
              <span className="ml-auto text-[10px] uppercase tracking-wide rounded-full bg-white/10 text-white/60 px-2 py-0.5">
                auto
              </span>
            </div>
            <p className="text-xs text-white/50 mb-3 break-words">
              {monitor.lastReason || 'Checking every few seconds…'}
            </p>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <Stat
                label="Checks"
                value={monitor.maxAttempts ? `${monitor.attempts}/${monitor.maxAttempts}` : String(monitor.attempts)}
              />
              <Stat label="Watching for" value={fmtElapsed(monitor.elapsedMs)} />
            </div>
            <p className="text-[11px] text-white/35 leading-relaxed mb-3">
              Keep this tab open. The moment the Space goes live and its audio is reachable, recording
              starts automatically from the beginning — you won't miss the opening.
            </p>
            <button
              className={BTN + ' w-full text-white'}
              style={{ background: 'rgba(255,255,255,0.08)' }}
              onClick={cancelMonitor}
            >
              <Square className="h-4 w-4" /> Cancel auto-capture
            </button>
          </div>
        )}

        {/* Job panels — one per recording (up to MAX_CONCURRENT run at once) */}
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} onStop={stopJob} onDismiss={dismissJob} />
        ))}

        {/* Manual fallback (demoted) */}
        <div className="mt-4">
          <button
            onClick={() => setShowManual((v) => !v)}
            className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/70"
          >
            <ChevronDown className={'h-3.5 w-3.5 transition ' + (showManual ? 'rotate-180' : '')} />
            Manual fallback: I already have the .m3u8 stream URL
          </button>
          {showManual && (
            <div className={CARD + ' mt-3'}>
              <div className="flex items-start gap-2 mb-3 text-[11px] text-white/45">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  Only needed for replays where auto-find fails. Open the replay in a desktop
                  browser → DevTools → Network → filter <code className="text-white/70">m3u8</code> →
                  copy the playlist URL.
                </span>
              </div>
              <input
                className={INPUT}
                name="manualM3u8"
                id="manualM3u8"
                autoComplete="off"
                placeholder="https://…/master_playlist.m3u8"
                value={streamUrl}
                onChange={(e) => setStreamUrl(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                className={BTN + ' mt-3 w-full text-white'}
                style={{ background: 'rgba(255,255,255,0.08)' }}
                disabled={!streamUrl.trim() || starting || atCapacity}
                onClick={() => startDownload(streamUrl.trim(), 'stream')}
              >
                <Download className="h-4 w-4" /> Record from URL
              </button>
            </div>
          )}
        </div>

        {/* Archive */}
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <ArchiveIcon className="h-4 w-4 text-white/60" />
            <h2 className="font-bold text-white/80">Your recordings</h2>
            <span className="text-xs text-white/30">
              ({archive.length}{totalBytes ? ` · ${fmtBytes(totalBytes)}` : ''})
            </span>
          </div>
          {staleCount > 0 && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-100/80">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Cleanup reminder: {staleCount} recording{staleCount > 1 ? 's are' : ' is'} more than 3
                days old. Delete what you no longer need to free up space (anything left untouched for
                30 days is removed automatically).
              </span>
            </div>
          )}
          {archive.length === 0 ? (
            <p className="text-xs text-white/30">
              Nothing archived yet. Recordings you make are saved here automatically.
            </p>
          ) : (
            <div className="space-y-2">
              {archive.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{r.name}</div>
                    <div className="text-[11px] text-white/40 flex flex-wrap gap-x-2">
                      <span>{fmtDate(r.created_at)}</span>
                      <span>· {fmtBytes(r.size_bytes)}</span>
                      <span>· {r.kind}</span>
                      {r.access_mode === 'connected_account' && (
                        <span className="text-sky-300">· connected account</span>
                      )}
                      {r.enhanced && <span className="text-[var(--brand-100,#ff2882)]">· enhanced</span>}
                      {!r.available && <span className="text-amber-300">· file cleared</span>}
                    </div>
                  </div>
                  {r.available && (
                    <button
                      className="p-2 rounded-lg hover:bg-white/10 text-white/70"
                      onClick={() => setClipFor(r)}
                      aria-label="Create clip"
                      title="Create a clip from this recording"
                    >
                      <Scissors className="h-4 w-4" />
                    </button>
                  )}
                  {r.available && (
                    <a
                      className="p-2 rounded-lg hover:bg-white/10 text-white/70"
                      href={api('space/file/' + r.id)}
                      aria-label="Download"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  )}
                  <button
                    className="p-2 rounded-lg hover:bg-red-500/15 text-white/50 hover:text-red-300"
                    onClick={() => deleteRec(r.id)}
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Clips library */}
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <Scissors className="h-4 w-4 text-white/60" />
            <h2 className="font-bold text-white/80">Your clips</h2>
            <span className="text-xs text-white/30">({clips.length})</span>
          </div>
          {clips.length === 0 ? (
            <p className="text-xs text-white/30">
              No clips yet. Tap the scissors on any recording above to cut a highlight — the original
              is never changed.
            </p>
          ) : (
            <div className="space-y-2">
              {clips.map((c) => (
                <ClipRow key={c.id} clip={c} onDelete={deleteClip} />
              ))}
            </div>
          )}
        </div>

        {/* Settings — X Account Connection */}
        <div className="mt-8" id="x-account-settings">
          <div className="flex items-center gap-2 mb-3">
            <Radio className="h-4 w-4 text-white/60" />
            <h2 className="font-bold text-white/80">X account connection</h2>
          </div>
          {connections.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-white/50 leading-relaxed mb-3">
                Connect your X account to record Spaces that require sign-in. Your session is
                validated with X, <b className="text-white/70">encrypted at rest</b>, never shown
                again, and you can disconnect anytime.
              </p>
              <button
                className={BTN + ' w-full text-white'}
                style={{ background: 'var(--brand-100,#ff2882)' }}
                onClick={() => setShowConnect(true)}
              >
                <Radio className="h-4 w-4" /> Connect an X account
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((c) => (
                <ConnectionCard
                  key={c.id}
                  conn={c}
                  onValidate={() => validateConn(c.id)}
                  onReconnect={() => setShowConnect(true)}
                  onDisconnect={() => disconnectConn(c.id)}
                />
              ))}
            </div>
          )}
        </div>

        <p className="mt-8 text-center text-[11px] text-white/25">
          For personal archiving. Respect creators' rights and X's terms when downloading.
        </p>
      </div>

      {clipFor && (
        <ClipModal
          rec={clipFor}
          onClose={() => setClipFor(null)}
          onCreated={() => {
            setClipFor(null)
            loadClips()
          }}
        />
      )}
      {showConnect && (
        <ConnectModal
          existing={anyConn}
          onClose={() => setShowConnect(false)}
          onConnected={() => {
            setShowConnect(false)
            loadConnections()
          }}
        />
      )}
    </div>
  )
}

function JobCard({
  job,
  onStop,
  onDismiss,
}: {
  job: JobStatus
  onStop: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const busy = job.state === 'downloading' || job.state === 'processing' || job.state === 'stopped'
  const recorded = job.recordedSecs || 0
  const totalSecs = job.totalSecs || 0
  const gaps = job.gaps || 0
  const backup = job.backup || null
  // For a replay we know the full length, so show a true percentage.
  const pct =
    job.kind === 'replay' && totalSecs > 0
      ? Math.min(100, Math.round((recorded / totalSecs) * 100))
      : null

  // Backup line: X publishes a full replay after a Space ends; we fetch it and
  // keep whichever copy is more complete.
  const backupNote =
    backup === 'pending'
      ? { tone: 'info', text: 'Also grabbing the complete replay as a backup once the Space ends…' }
      : backup === 'recording'
      ? { tone: 'info', text: 'Downloading the complete replay as a backup…' }
      : backup === 'kept-replay'
      ? { tone: 'ok', text: `Kept the complete replay (${fmtClock(recorded)}) — the most complete copy.` }
      : backup === 'kept-live'
      ? { tone: 'ok', text: 'Your live capture was the most complete copy — kept it.' }
      : backup === 'unavailable'
      ? { tone: 'muted', text: 'No published replay to back up from — your live capture is saved.' }
      : null

  const title =
    job.state === 'ready'
      ? 'Recording saved'
      : job.state === 'error'
      ? 'Something went wrong'
      : job.state === 'processing'
      ? 'Cleaning up the audio…'
      : job.state === 'stopped'
      ? 'Finishing up…'
      : job.kind === 'live'
      ? 'Recording live — audio is being captured'
      : 'Downloading the replay…'

  // Plain-language explanation of exactly what's happening right now.
  const explain =
    job.state === 'ready'
      ? `You captured ${fmtClock(recorded)} of audio. Tap Download to save the file.`
      : job.state === 'error'
      ? 'The recording stopped early. Anything captured before the error is still saved below if available.'
      : job.state === 'processing'
      ? 'Stitching the chunks together and encoding a clean file — this only takes a moment.'
      : job.state === 'stopped'
      ? 'Wrapping up your file with everything captured so far.'
      : job.kind === 'live'
      ? recorded > 0
        ? `So far we've saved ${fmtClock(recorded)} of this Space, pulled from the start. It keeps growing until the Space ends or you hit Stop & save — everything captured is kept.`
        : job.elapsedMs > 12000
        ? "Connected — but no audio has aired yet. This is normal if the host is silent or stepped away (e.g. \u201cbrb\u201d). We're holding the line and will save audio the instant it starts."
        : 'Connecting to the live audio and pulling from the beginning… the counter starts moving once the first chunk arrives.'
      : pct !== null
      ? `Downloaded ${fmtClock(recorded)} of ${fmtClock(totalSecs)} (${pct}%). It stops on its own when the whole replay is saved.`
      : `Downloaded ${fmtClock(recorded)} of audio so far…`

  return (
    <div className={CARD + ' mt-4'}>
      <div className="flex items-center gap-2 mb-1">
        {job.state === 'ready' ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
        ) : job.state === 'error' ? (
          <AlertTriangle className="h-5 w-5 text-red-400" />
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-[var(--brand-100,#ff2882)]" />
        )}
        <span className="font-bold truncate">{title}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide rounded-full bg-white/10 text-white/60 px-2 py-0.5 shrink-0">
          {job.kind}
        </span>
        {(job.state === 'ready' || job.state === 'error') && (
          <button
            className="p-1 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/70 shrink-0"
            onClick={() => onDismiss(job.id)}
            aria-label="Dismiss"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {job.name && <p className="text-xs text-white/45 mb-3 truncate">{job.name}</p>}

      {/* Plain-language status — answers "what's happening / how much do I have" */}
      <p className="text-xs text-white/60 leading-relaxed mb-3">{explain}</p>

      {backupNote && (
        <div
          className={
            'mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed ' +
            (backupNote.tone === 'ok'
              ? 'bg-emerald-500/10 text-emerald-200'
              : backupNote.tone === 'info'
              ? 'bg-white/[0.04] text-white/60'
              : 'text-white/40')
          }
        >
          {backupNote.tone === 'ok' ? (
            <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          ) : backupNote.tone === 'info' ? (
            <Loader2 className="h-3.5 w-3.5 mt-0.5 shrink-0 animate-spin" />
          ) : (
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          )}
          <span>{backupNote.text}</span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 mb-2">
        <Stat
          label="Audio captured"
          value={fmtClock(recorded)}
          hint="Length of the recording so far"
        />
        <Stat label="File size" value={fmtBytes(job.sizeBytes)} hint="How big the download is" />
        <Stat
          label={job.kind === 'live' ? 'Time on air' : 'Time spent'}
          value={fmtElapsed(job.elapsedMs)}
          hint="Real time since this started"
        />
      </div>

      {gaps > 0 && busy && (
        <p className="text-[11px] text-amber-200/70 mb-2">
          {gaps} short chunk{gaps > 1 ? 's' : ''} couldn't be fetched and {gaps > 1 ? 'were' : 'was'}{' '}
          skipped — the rest of the audio is intact.
        </p>
      )}

      {/* Listen right here — while recording (what's captured so far) or when done */}
      {(job.state === 'ready' || (busy && recorded > 0)) && (
        <Player id={job.id} live={busy} />
      )}
      {busy && recorded > 0 && (
        <p className="-mt-1 mb-3 text-[11px] text-white/35 leading-relaxed">
          You can listen now — this plays everything captured up to a moment ago. Tap{' '}
          <b className="text-white/50">Refresh</b> to pull in the newest audio while it keeps recording.
        </p>
      )}

      {busy && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10 mb-4 mt-2">
          <div
            className={'h-full rounded-full transition-all ' + (pct === null ? 'animate-pulse' : '')}
            style={{
              background: 'var(--brand-100,#ff2882)',
              width: pct !== null ? `${pct}%` : '100%',
            }}
          />
        </div>
      )}

      {job.state === 'error' && job.error && (
        <p className="text-xs text-red-300/80 mb-3 break-words">{job.error}</p>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mt-2">
        {busy && job.kind === 'live' && (
          <button
            className={BTN + ' flex-1 text-white'}
            style={{ background: 'rgba(255,255,255,0.08)' }}
            onClick={() => onStop(job.id)}
          >
            <Square className="h-4 w-4" /> Stop &amp; save
          </button>
        )}
        {job.state === 'ready' && (
          <a
            className={BTN + ' flex-1 text-white'}
            style={{ background: 'var(--brand-100,#ff2882)' }}
            href={api('space/file/' + job.id)}
          >
            <Download className="h-4 w-4" /> Download ({fmtClock(recorded)})
          </a>
        )}
      </div>

      {busy && job.kind === 'live' && (
        <p className="mt-3 text-[11px] text-white/35 leading-relaxed">
          <b className="text-white/50">When can I stop?</b> Any time — the counter above is exactly
          what you'll get. If you're waiting for the whole Space, leave it running; it finishes on its
          own the moment the host ends the Space.
        </p>
      )}
    </div>
  )
}

// In-app audio player. While recording it plays what's captured "so far" and
// lets you reload to pull in the newer audio; when finished it plays the whole
// file. Uses the streaming /preview endpoint (Range-enabled) so it works on a
// file that's still being written.
function Player({ id, live }: { id: string; live: boolean }) {
  const [src, setSrc] = useState(() => api('space/preview/' + id) + '?t=' + Date.now())
  const reload = () => setSrc(api('space/preview/' + id) + '?t=' + Date.now())
  return (
    <div className="mb-3">
      <audio key={src} controls preload="none" className="w-full h-9" src={src} />
      {live && (
        <button
          onClick={reload}
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80"
        >
          <Loader2 className="h-3 w-3" /> Refresh to hear the latest audio
        </button>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="rounded-xl bg-black/30 border border-white/10 px-2 py-3 text-center"
      title={hint}
    >
      <div className="text-base font-bold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-white/40 mt-0.5">{label}</div>
    </div>
  )
}

// One row in the Clips library: inline player, download, delete, and an
// attribution line pointing back to the source recording + original position.
function ClipRow({ clip, onDelete }: { clip: Clip; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const parent = clip.parent_title || clip.parent_name || 'a recording'
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{clip.title}</div>
          <div className="text-[11px] text-white/40 flex flex-wrap gap-x-2">
            <span>{fmtClock(clip.duration_seconds)}</span>
            <span>· {fmtBytes(clip.size_bytes)}</span>
            {clip.enhanced && <span className="text-[var(--brand-100,#ff2882)]">· enhanced</span>}
            {clip.status !== 'completed' && <span className="text-amber-300">· {clip.status}</span>}
            {!clip.available && <span className="text-amber-300">· file cleared</span>}
          </div>
        </div>
        {clip.available && (
          <button
            className="p-2 rounded-lg hover:bg-white/10 text-white/70"
            onClick={() => setOpen((v) => !v)}
            aria-label="Play"
          >
            <Play className="h-4 w-4" />
          </button>
        )}
        {clip.available && (
          <a
            className="p-2 rounded-lg hover:bg-white/10 text-white/70"
            href={api('space/clip/' + clip.id + '/file')}
            aria-label="Download"
          >
            <Download className="h-4 w-4" />
          </a>
        )}
        <button
          className="p-2 rounded-lg hover:bg-red-500/15 text-white/50 hover:text-red-300"
          onClick={() => onDelete(clip.id)}
          aria-label="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {open && clip.available && (
        <audio
          controls
          preload="none"
          className="w-full h-9 mt-3"
          src={api('space/clip/' + clip.id + '/file') + '?play=1'}
        />
      )}
      <div className="mt-2 text-[11px] text-white/35">
        Clip from: <span className="text-white/55">{parent}</span> · Original position:{' '}
        {fmtClock(clip.start_seconds)}–{fmtClock(clip.end_seconds)}
      </div>
    </div>
  )
}

// Modal to cut a clip from a recording. Timestamps accept flexible formats
// (see parseTimestamp). Validates the range client-side before sending, offers a
// scrub-to-preview of the source, and shows the computed clip length live.
function ClipModal({
  rec,
  onClose,
  onCreated,
}: {
  rec: Rec
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [startRaw, setStartRaw] = useState('')
  const [endRaw, setEndRaw] = useState('')
  const [enhance, setEnhance] = useState(false)
  const [dur, setDur] = useState<number | null>(rec.duration_seconds ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Get the true source length so we can validate against it.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch(api('space/recordings/' + rec.id + '/duration'))
        if (r.ok) {
          const d = await r.json()
          if (alive && typeof d.duration_seconds === 'number') setDur(d.duration_seconds)
        }
      } catch {}
    })()
    return () => {
      alive = false
    }
  }, [rec.id])

  const start = parseTimestamp(startRaw)
  const end = parseTimestamp(endRaw)
  const clipLen = start !== null && end !== null ? end - start : null

  let validationErr: string | null = null
  if (startRaw && start === null) validationErr = "Start time isn't a valid timestamp."
  else if (endRaw && end === null) validationErr = "End time isn't a valid timestamp."
  else if (start !== null && start < 0) validationErr = 'Start time cannot be negative.'
  else if (start !== null && end !== null && end <= start)
    validationErr = 'End time must be after the start time.'
  else if (dur !== null && end !== null && end > dur + 0.5)
    validationErr = `End time is past the recording length (${fmtClock(dur)}).`

  const canCreate = !!title.trim() && start !== null && end !== null && !validationErr && !busy

  function previewFrom(sec: number | null) {
    const a = audioRef.current
    if (!a || sec === null) return
    try {
      a.currentTime = Math.max(0, sec)
      a.play()
    } catch {}
  }

  async function create() {
    if (!canCreate || start === null || end === null) return
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch(api('space/recordings/' + rec.id + '/clips'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          start_seconds: start,
          end_seconds: end,
          enhance,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not create the clip.')
      onCreated()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#111117] p-5 max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <Scissors className="h-4 w-4 text-[var(--brand-100,#ff2882)]" />
          <h2 className="font-bold">Create a clip</h2>
          <button
            className="ml-auto p-1 rounded-lg hover:bg-white/10 text-white/50"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-white/40 mb-4 truncate">
          From: {rec.title || rec.name}
          {dur !== null && <span className="text-white/30"> · {fmtClock(dur)} long</span>}
        </p>

        {/* Scrub source to find your in/out points */}
        <audio
          ref={audioRef}
          controls
          preload="none"
          className="w-full h-9 mb-4"
          src={api('space/preview/' + rec.id) + '?play=1'}
        />

        <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">
          Clip title
        </label>
        <input
          className={INPUT}
          placeholder="e.g. The part about AI agents"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">
              Start
            </label>
            <input
              className={INPUT}
              placeholder="1:30"
              value={startRaw}
              onChange={(e) => setStartRaw(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80 disabled:opacity-30"
              disabled={start === null}
              onClick={() => previewFrom(start)}
            >
              <Play className="h-3 w-3" /> Preview
            </button>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">
              End
            </label>
            <input
              className={INPUT}
              placeholder="2:45"
              value={endRaw}
              onChange={(e) => setEndRaw(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80 disabled:opacity-30"
              disabled={end === null}
              onClick={() => previewFrom(end)}
            >
              <Play className="h-3 w-3" /> Preview
            </button>
          </div>
        </div>

        <p className="mt-2 text-[11px] text-white/35 leading-relaxed">
          Formats: <code className="text-white/55">1:30</code> (m:ss),{' '}
          <code className="text-white/55">1:02:03</code> (h:mm:ss),{' '}
          <code className="text-white/55">90</code> (seconds), or{' '}
          <code className="text-white/55">1m30s</code>.
        </p>

        <div className="mt-3 rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-xs">
          {clipLen !== null && !validationErr ? (
            <span className="text-emerald-200">
              Clip length: <b>{fmtClock(clipLen)}</b>
            </span>
          ) : validationErr ? (
            <span className="text-amber-300">{validationErr}</span>
          ) : (
            <span className="text-white/40">Enter a start and end time to see the clip length.</span>
          )}
        </div>

        <button
          onClick={() => setEnhance((v) => !v)}
          className="w-full mt-3 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left"
        >
          <Sparkles className="h-5 w-5 text-[var(--brand-100,#ff2882)] shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Enhance this clip's audio</div>
            <div className="text-[11px] text-white/45">Normalize loudness & clean low-end rumble.</div>
          </div>
          <span
            className={
              'relative h-6 w-11 rounded-full transition shrink-0 ' +
              (enhance ? 'bg-[var(--brand-100,#ff2882)]' : 'bg-white/15')
            }
          >
            <span
              className={
                'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ' +
                (enhance ? 'left-[22px]' : 'left-0.5')
              }
            />
          </span>
        </button>

        {err && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <button
          className={BTN + ' mt-4 w-full text-white'}
          style={{ background: 'var(--brand-100,#ff2882)' }}
          disabled={!canCreate}
          onClick={create}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
          {busy ? 'Cutting the clip…' : 'Create clip'}
        </button>
        <p className="mt-2 text-[11px] text-white/30 text-center">
          Your original recording is never changed — this saves a separate clip.
        </p>
      </div>
    </div>
  )
}

// A connected X account: identity, status, and lifecycle controls. Never shows
// any credential material — only metadata the backend returns.
function ConnectionCard({
  conn,
  onValidate,
  onReconnect,
  onDisconnect,
}: {
  conn: XConnection
  onValidate: () => void
  onReconnect: () => void
  onDisconnect: () => void
}) {
  const [busy, setBusy] = useState<'validate' | 'disconnect' | null>(null)
  const statusTone =
    conn.status === 'active'
      ? 'text-emerald-300'
      : conn.status === 'reauth_required' || conn.status === 'expired'
      ? 'text-amber-300'
      : 'text-white/50'
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 shrink-0 overflow-hidden">
          {conn.avatar_url ? (
            <img src={conn.avatar_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <Radio className="h-4 w-4 text-white/60" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            @{conn.x_handle || 'account'}{' '}
            {conn.display_name && (
              <span className="font-normal text-white/40">· {conn.display_name}</span>
            )}
          </div>
          <div className={'text-[11px] font-medium ' + statusTone}>
            {conn.status === 'active'
              ? 'Active'
              : conn.status === 'reauth_required'
              ? 'Needs reconnect'
              : conn.status}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-white/45">
        <div>Type: {conn.auth_type === 'oauth' ? 'OAuth' : 'Authenticated session'}</div>
        <div>Access: {conn.granted_scopes || '—'}</div>
        <div>Connected: {conn.connected_at ? fmtDate(conn.connected_at) : '—'}</div>
        <div>Last verified: {conn.last_validated_at ? fmtDate(conn.last_validated_at) : '—'}</div>
        <div>Last used: {conn.last_used_at ? fmtDate(conn.last_used_at) : 'never'}</div>
        <div className="text-emerald-300/70">
          {conn.encrypted ? 'Encrypted at rest' : ''}
          {conn.key_managed ? ' · managed key' : ''}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-40"
          disabled={busy !== null}
          onClick={async () => {
            setBusy('validate')
            await onValidate()
            setBusy(null)
          }}
        >
          {busy === 'validate' ? 'Checking…' : 'Verify now'}
        </button>
        <button
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-white/70 hover:bg-white/10"
          onClick={onReconnect}
        >
          Reconnect
        </button>
        <button
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300 hover:bg-red-500/20 disabled:opacity-40"
          disabled={busy !== null}
          onClick={async () => {
            setBusy('disconnect')
            await onDisconnect()
            setBusy(null)
          }}
        >
          {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    </div>
  )
}

// Secure account-connection flow. This is the ONLY place credentials are ever
// entered — behind explicit consent, sent once over HTTPS to a dedicated
// endpoint, validated with X, then encrypted server-side and never returned.
function ConnectModal({
  existing,
  onClose,
  onConnected,
}: {
  existing: XConnection | null
  onClose: () => void
  onConnected: () => void
}) {
  const [cookie, setCookie] = useState('')
  const [csrf, setCsrf] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const reconnecting = !!existing

  const canSubmit = cookie.trim().length > 0 && consent && !busy

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      const path = reconnecting ? 'x-connections/' + existing!.id + '/reconnect' : 'x-connections/complete'
      const r = await fetch(api(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_type: 'session',
          cookie: cookie.trim(),
          csrf: csrf.trim() || undefined,
          consent: true,
        }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not connect the account.')
      onConnected()
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#111117] p-5 max-h-[92vh] overflow-y-auto"
        style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <Radio className="h-4 w-4 text-[var(--brand-100,#ff2882)]" />
          <h2 className="font-bold">{reconnecting ? 'Reconnect X account' : 'Connect an X account'}</h2>
          <button
            className="ml-auto p-1 rounded-lg hover:bg-white/10 text-white/50"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-white/45 mb-4 leading-relaxed">
          This authorizes the dashboard to use your X account's access to resolve and record Spaces
          you instruct it to. Your session is validated with X, encrypted at rest, and never shown
          again.
        </p>

        <div className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100/80 leading-relaxed mb-4">
          The dashboard will <b>never</b> display or ask for your X password. Do not enter a password
          anywhere in this app. You can revoke access from your X account security settings as well as
          from here.
        </div>

        <label className="block text-[11px] uppercase tracking-wide text-white/40 mb-1">
          Authenticated session (cookie header)
        </label>
        <input
          className={INPUT}
          autoComplete="off"
          placeholder="auth_token=…; ct0=…"
          value={cookie}
          onChange={(e) => setCookie(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <input
          className={INPUT + ' mt-2'}
          autoComplete="off"
          placeholder="ct0 value (optional — auto-read from the cookie)"
          value={csrf}
          onChange={(e) => setCsrf(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <div className="mt-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-[11px] text-white/45 leading-relaxed">
          <b className="text-white/60">Where to find this:</b> On a computer, sign in at x.com → open
          DevTools (F12) → <b>Application</b> → <b>Cookies</b> →{' '}
          <code className="text-white/70">https://x.com</code>. Copy the{' '}
          <code className="text-white/70">auth_token</code> and{' '}
          <code className="text-white/70">ct0</code> values as{' '}
          <code className="text-white/70">auth_token=…; ct0=…</code>.
        </div>

        <label className="flex items-start gap-2 mt-4 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 accent-[var(--brand-100,#ff2882)]"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span className="text-[11px] text-white/60 leading-relaxed">
            I confirm that I own this X account or am authorized to connect it. I authorize this
            dashboard to use the account's available access only to resolve and record Spaces that I
            instruct it to record. I understand I can disconnect at any time.
          </span>
        </label>

        {err && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <button
          className={BTN + ' mt-4 w-full text-white'}
          style={{ background: 'var(--brand-100,#ff2882)' }}
          disabled={!canSubmit}
          onClick={submit}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {busy ? 'Validating with X…' : reconnecting ? 'Reconnect account' : 'Connect account'}
        </button>
      </div>
    </div>
  )
}
