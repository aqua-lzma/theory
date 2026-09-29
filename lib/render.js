import { SnowflakeUtil } from 'discord.js'
import { getMessage, getMessages, getUsers } from './db.js'

const pad = (n) => String(n).padStart(2, '0')

const formatDate = (ts) => {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const formatTime = (ts) => {
  const d = new Date(ts)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const QUOTE_MAX = 200

// markers and quotes must occupy exactly one line: collapse runs of
// whitespace (multiline media descriptions, embed texts) into single spaces
const flatten = (text) => text.replace(/\s+/g, ' ').trim()

const mediaMarker = (media) =>
  `[${media.type[0].toUpperCase()}${media.type.slice(1)}${media.description ? `: ${flatten(media.description)}` : ''}]`

// Mention markup resolved the way a client user sees it: @nickname from the
// users table, @role and #channel from the mention maps stored at ingest,
// with clean placeholders on lookup misses. Sole-link content was already
// blanked at ingest, so there is nothing else to clean here.
const cleanContent = (content, mentionsJson, userLabels) => {
  if (!content) return ''
  const mentions = JSON.parse(mentionsJson ?? 'null')
  return content
    .replace(/<@!?(\d+)>/g, (_, id) => `@${userLabels.get(id) ?? 'unknown-user'}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${mentions?.roles?.[id] ?? 'unknown-role'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${mentions?.channels?.[id] ?? 'unknown-channel'}`)
}

// Render a message window as a transcript. `channel` is a { id, name }
// object (any discord.js channel works); the window spans beforeId..afterId
// inclusive, null meaning channel start/end. Consecutive messages from the
// same author collapse into one block; replies, forwards, media and
// reactions render as indented marker lines; mention markup is cleaned to
// display names (see cleanContent).
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

  // reply targets are resolved up front: their cleaned content feeds the
  // quote previews and their mention ids join the label lookup
  const targets = new Map()
  for (const m of rows) {
    const ref = m.reference ? JSON.parse(m.reference) : null
    if (ref?.type === 'reply') {
      const target = getMessage(ref.messageId)
      if (target) targets.set(ref.messageId, target)
    }
  }
  const userLabels = getUsers([...new Set(
    rows.concat([...targets.values()])
      .flatMap((m) => [...(m.content ?? '').matchAll(/<@!?(\d+)>/g)].map((x) => x[1]))
  )])

  let prevAuthor = null
  for (const m of rows) {
    if (m.author_id !== prevAuthor) {
      lines.push(`[${formatTime(SnowflakeUtil.timestampFrom(m.id))}] ${m.author}`)
      prevAuthor = m.author_id
    }
    const ref = m.reference ? JSON.parse(m.reference) : null
    if (ref?.type === 'reply') {
      const target = targets.get(ref.messageId)
      if (target) {
        let quote = flatten(cleanContent(target.content, target.mentions, userLabels))
        if (!quote) quote = JSON.parse(target.media ?? '[]').map(mediaMarker).join(' ')
        const cut = quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX)}…` : quote
        lines.push(`  [Reply to @${target.author}]${cut ? ` ${cut}` : ''}`)
      } else {
        lines.push('  [Reply to unknown]')
      }
    } else if (ref) {
      lines.push('  [Forwarded]')
    }
    const body = cleanContent(m.content, m.mentions, userLabels)
    if (body) {
      for (const part of body.split('\n')) lines.push(`  ${part}`)
    }
    // media markers carry the ai-generated description when one has landed
    for (const entry of JSON.parse(m.media ?? '[]')) lines.push(`  ${mediaMarker(entry)}`)
    const reactions = JSON.parse(m.reactions ?? '[]')
    if (reactions.length) {
      lines.push(`  [Reactions] ${reactions.map((r) => `:${r.emoji}: x${r.count}`).join(', ')}`)
    }
  }
  return lines.join('\n') + '\n'
}
