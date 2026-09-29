// Central logging: level-filtered line output plus the pipeline status table.
// Level is set via --log-level=<error|warn|info|debug> (default info).
// Status table: one row per scraped channel (channel | phase | fetches |
// messages | chunks | embedded | chars | avg) plus a Total row, re-rendered
// in place via ANSI cursor movement whenever stdout is a TTY, at any log
// level; without a TTY it degrades to one plain log line per event, active
// only at debug level. messages/chunks/embedded are pulled from the db at
// render time; fetches and chars are per-run (in-memory) counters, chars
// keyed by chunk id so re-renders overwrite instead of double-counting. The
// table stays pinned at the bottom of the output: each stdout log line erases
// it, prints, and redraws it below itself (stderr lines may still clobber it
// - known limitation).

import { format, parseArgs } from 'node:util'
import { getChannelStats } from './db.js'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

const { values } = parseArgs({
  strict: false,
  options: { 'log-level': { type: 'string' } }
})
const level = LEVELS[values['log-level']] ?? LEVELS.info

// set by the TTY table below: intercepts stdout lines so the table can be
// erased before and redrawn after them
let stdoutHook = null

function write (lvl, stream, ...args) {
  if (LEVELS[lvl] > level) return
  const line = `${new Date().toISOString()} ${lvl.padEnd(5)} ${format(...args)}\n`
  if (stream === process.stdout && stdoutHook) {
    stdoutHook(line)
    return
  }
  stream.write(line)
}

const progress = { update () {}, done () {}, refresh () {}, chars () {} }

// the table runs whenever stdout is a TTY, debug flag or no; the plain-line
// fallback is what stays gated on debug level
if (process.stdout.isTTY) {
  const rows = new Map() // id -> { name, phase, fetches }
  const chars = new Map() // chunkId -> { channelId, n }
  let prevLines = 0

  const render = () => {
    if (!rows.size) return
    const stats = getChannelStats()
    const rendered = new Map() // channelId -> { chars, renders, max }
    for (const c of chars.values()) {
      const r = rendered.get(c.channelId) ?? { chars: 0, renders: 0, max: 0 }
      r.chars += c.n
      r.renders++
      r.max = Math.max(r.max, c.n)
      rendered.set(c.channelId, r)
    }
    const body = []
    let sumFetches = 0
    let sumMessages = 0
    let sumChunks = 0
    let sumEmbedded = 0
    let sumChars = 0
    let sumMax = 0
    let sumRenders = 0
    for (const [id, row] of rows) {
      const s = stats.get(id) ?? { messages: 0, chunks: 0, embedded: 0 }
      const r = rendered.get(id) ?? { chars: 0, renders: 0, max: 0 }
      sumFetches += row.fetches
      sumMessages += s.messages
      sumChunks += s.chunks
      sumEmbedded += s.embedded
      sumChars += r.chars
      sumMax = Math.max(sumMax, r.max)
      sumRenders += r.renders
      body.push([row.name, row.phase, row.fetches, s.messages, s.chunks, s.embedded, r.chars, r.max, r.renders ? Math.round(r.chars / r.renders) : 0])
    }
    body.push(['Total', '', sumFetches, sumMessages, sumChunks, sumEmbedded, sumChars, sumMax, sumRenders ? Math.round(sumChars / sumRenders) : 0])
    const headers = ['channel', 'phase', 'fetches', 'messages', 'chunks', 'embedded', 'chars', 'max', 'avg']
    const widths = headers.map((h, i) => Math.max(h.length, ...body.map((c) => String(c[i]).length)))
    const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i] + 2)).join('').trimEnd()
    const out = [
      line(headers),
      line(widths.map((w) => '-'.repeat(w))),
      ...body.map((c) => line(c))
    ]
    if (prevLines > 0) process.stdout.write(`\x1b[${prevLines}F`)
    for (const l of out) process.stdout.write(`\x1b[2K${l}\n`)
    prevLines = out.length
  }

  stdoutHook = (line) => {
    if (prevLines === 0) {
      process.stdout.write(line)
      return
    }
    process.stdout.write(`\x1b[${prevLines}F\x1b[J`)
    prevLines = 0
    process.stdout.write(line)
    render()
  }

  progress.update = (id, name, phase, fetches) => {
    rows.set(id, { name, phase, fetches })
    render()
  }
  progress.done = (id, name, fetches) => {
    progress.update(id, name, 'done', fetches)
  }
  progress.refresh = render
  progress.chars = (chunkId, channelId, n) => {
    chars.set(chunkId, { channelId, n })
    render()
  }
} else if (level >= LEVELS.debug) {
  const rows = new Map() // id -> { name, phase, fetches }
  const chars = new Map() // chunkId -> { channelId, n }
  const lastStats = new Map() // id -> stats signature last logged

  progress.update = (id, name, phase, fetches) => {
    rows.set(id, { name, phase, fetches })
    write('debug', process.stdout, `[scrape] ${name} phase=${phase} fetches=${fetches}`)
  }
  progress.done = (id, name, fetches) => {
    progress.update(id, name, 'done', fetches)
  }
  progress.refresh = () => {
    const stats = getChannelStats()
    for (const [id, row] of rows) {
      const s = stats.get(id) ?? { messages: 0, chunks: 0, embedded: 0 }
      const rendered = [...chars.values()].filter((c) => c.channelId === id)
      const total = rendered.reduce((acc, c) => acc + c.n, 0)
      const max = rendered.reduce((acc, c) => Math.max(acc, c.n), 0)
      const sig = `${s.messages}/${s.chunks}/${s.embedded}/${total}/${max}`
      if (sig === lastStats.get(id)) continue
      lastStats.set(id, sig)
      write('debug', process.stdout, `[stats] ${row.name} messages=${s.messages} chunks=${s.chunks} embedded=${s.embedded} chars=${total} max=${max}`)
    }
  }
  progress.chars = (chunkId, channelId, n) => {
    chars.set(chunkId, { channelId, n })
    progress.refresh()
  }
}

export const log = {
  error: (...args) => write('error', process.stderr, ...args),
  warn: (...args) => write('warn', process.stderr, ...args),
  info: (...args) => write('info', process.stdout, ...args),
  debug: (...args) => write('debug', process.stdout, ...args),
  progress
}
