import { SnowflakeUtil } from 'discord.js'
import { getMessage, getMessages } from './db.js'

const pad = (n) => String(n).padStart(2, '0')

const formatDate = (ts) => {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const formatTime = (ts) => {
  const d = new Date(ts)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// Render a message window as a transcript. `channel` is a { id, name }
// object (any discord.js channel works); the window spans beforeId..afterId
// inclusive, null meaning channel start/end. Consecutive messages from the
// same author collapse into one block; replies, forwards, media and
// reactions render as indented marker lines.
export function renderChunk (channel, beforeId, afterId) {
  const rows = [
    ...(beforeId != null ? [getMessage(beforeId)] : []),
    ...getMessages(channel.id, { after: beforeId, before: afterId }),
    ...(afterId != null && afterId !== beforeId ? [getMessage(afterId)] : [])
  ].filter(Boolean)
  if (!rows.length) return ''

  const start = SnowflakeUtil.timestampFrom(rows[0].id)
  const end = SnowflakeUtil.timestampFrom(rows[rows.length - 1].id)
  const startDate = new Date(start)
  const endDate = new Date(end)
  const sameDay = startDate.getUTCFullYear() === endDate.getUTCFullYear() &&
    startDate.getUTCMonth() === endDate.getUTCMonth() &&
    startDate.getUTCDate() === endDate.getUTCDate()

  const members = rows.filter((m, i) => rows.findIndex((x) => x.author_id === m.author_id) === i)
  const lines = [
    `#${channel.name} ${formatDate(start)} -> ${sameDay ? formatTime(end) : formatDate(end)}`,
    `Members: ${members.map((m) => `${m.author_id} @${m.username ?? m.author_id}${m.nickname ? ` (${m.nickname})` : ''}`).join(', ')}`,
    'Messages:'
  ]

  let prevAuthor = null
  for (const m of rows) {
    if (m.author_id !== prevAuthor) {
      lines.push(`[${formatTime(SnowflakeUtil.timestampFrom(m.id))}] ${m.author}`)
      prevAuthor = m.author_id
    }
    const ref = m.reference ? JSON.parse(m.reference) : null
    let prefix = ''
    if (ref) {
      if (ref.type === 'reply') {
        const target = getMessage(ref.messageId)
        prefix = `${target ? `[Reply to @${target.author}]` : '[Reply to]'} `
      } else {
        prefix = '[Forwarded]\n'
      }
    }
    if (m.content) {
      const parts = m.content.split('\n')
      lines.push(`  ${prefix}${parts[0]}`)
      for (let i = 1; i < parts.length; i++) lines.push(`  ${parts[i]}`)
    } else if (prefix) {
      lines.push(`  ${prefix.trimEnd()}`)
    }
    // image descriptions aren't generated yet, so media markers stay bare
    for (const media of JSON.parse(m.media ?? '[]')) {
      lines.push(`  [${media.type[0].toUpperCase()}${media.type.slice(1)}]`)
    }
    const reactions = JSON.parse(m.reactions ?? '[]')
    if (reactions.length) {
      lines.push(`  [Reactions] ${reactions.map((r) => `:${r.emoji}: x${r.count}`).join(', ')}`)
    }
  }
  return lines.join('\n') + '\n'
}
