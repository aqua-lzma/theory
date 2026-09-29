// Live re-rendered progress table for --debug mode.
// One row per channel: name | phase | batches | messages.
// Re-renders in place via ANSI cursor movement; no-op when disabled or not a TTY.

export function createDebugTable (enabled) {
  if (!enabled || !process.stdout.isTTY) {
    return {
      update () {},
      done () {}
    }
  }

  const rows = new Map() // id -> { name, phase, batches, messages }
  let prevLines = 0

  function render () {
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

  return {
    update (id, name, phase, batches, messages) {
      rows.set(id, { name, phase, batches, messages })
      render()
    },
    done (id, name, batches, messages) {
      this.update(id, name, 'done', batches, messages)
    }
  }
}
