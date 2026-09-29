// Central logging: level-filtered line output plus the scrape progress table.
// Level is set via --log-level=<error|warn|info|debug> (default info).
// Progress table: one row per channel (name | phase | batches | messages),
// re-rendered in place via ANSI cursor movement when stdout is a TTY; when it
// is not, one plain line per event instead. Only active at debug level.

import { format, parseArgs } from 'node:util'

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }

const { values } = parseArgs({
  strict: false,
  options: { 'log-level': { type: 'string' } }
})
const level = LEVELS[values['log-level']] ?? LEVELS.info

function write (lvl, stream, ...args) {
  if (LEVELS[lvl] > level) return
  stream.write(`${new Date().toISOString()} ${lvl.padEnd(5)} ${format(...args)}\n`)
}

const progress = { update () {}, done () {} }

if (level >= LEVELS.debug) {
  if (process.stdout.isTTY) {
    const rows = new Map() // id -> { name, phase, batches, messages }
    let prevLines = 0

    const render = () => {
      const entries = [...rows.values()]
      const widths = {
        channel: Math.max('channel'.length, ...entries.map((r) => r.name.length)),
        phase: Math.max('phase'.length, ...entries.map((r) => r.phase.length)),
        batches: Math.max('batches'.length, ...entries.map((r) => String(r.batches).length)),
        messages: Math.max('messages'.length, ...entries.map((r) => String(r.messages).length))
      }
      const line = (cells) => cells.map((c, i) => String(c).padEnd(Object.values(widths)[i] + 2)).join('').trimEnd()
      const out = [
        line(['channel', 'phase', 'batches', 'messages']),
        line([
          '-'.repeat(widths.channel),
          '-'.repeat(widths.phase),
          '-'.repeat(widths.batches),
          '-'.repeat(widths.messages)
        ]),
        ...entries.map((r) => line([r.name, r.phase, r.batches, r.messages]))
      ]
      if (prevLines > 0) process.stdout.write(`\x1b[${prevLines}F`)
      for (const l of out) process.stdout.write(`\x1b[2K${l}\n`)
      prevLines = out.length
    }

    progress.update = (id, name, phase, batches, messages) => {
      rows.set(id, { name, phase, batches, messages })
      render()
    }
    progress.done = (id, name, batches, messages) => {
      progress.update(id, name, 'done', batches, messages)
    }
  } else {
    progress.update = (id, name, phase, batches, messages) => {
      write('debug', process.stdout, `[scrape] ${name} phase=${phase} batches=${batches} messages=${messages}`)
    }
    progress.done = (id, name, batches, messages) => {
      write('debug', process.stdout, `[scrape] ${name} done batches=${batches} messages=${messages}`)
    }
  }
}

export const log = {
  error: (...args) => write('error', process.stderr, ...args),
  warn: (...args) => write('warn', process.stderr, ...args),
  info: (...args) => write('info', process.stdout, ...args),
  debug: (...args) => write('debug', process.stdout, ...args),
  progress
}
