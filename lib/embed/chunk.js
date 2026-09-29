import { SnowflakeUtil } from 'discord.js'
import {
  deleteChunk,
  extendChunk,
  getLastChunk,
  getMessageChannelIds,
  getMessages,
  insertChunk,
  setChunkEmbedding,
  setChunkOpen
} from '../db.js'
import { log } from '../log.js'

export const GAP_MS = 5 * 60_000
const MAX_MESSAGES = 50

// Split an oversized id range at its longest internal time gap, breaking
// ties toward the midpoint (uniformly spaced bursts), recursively until
// each piece fits.
function subsplit (ids) {
  if (ids.length <= MAX_MESSAGES || ids.length === 1) {
    return [ids]
  }
  const mid = (ids.length - 1) / 2
  let splitAt = Math.floor(mid)
  let splitGap = -Infinity
  for (let i = 0; i < ids.length - 1; i++) {
    const gap = SnowflakeUtil.timestampFrom(ids[i + 1]) - SnowflakeUtil.timestampFrom(ids[i])
    if (gap > splitGap || (gap === splitGap && Math.abs(i - mid) < Math.abs(splitAt - mid))) {
      splitGap = gap
      splitAt = i
    }
  }
  return [...subsplit(ids.slice(0, splitAt + 1)), ...subsplit(ids.slice(splitAt + 1))]
}

// Fold one message into the channel's chunk state: append to the open tail
// when it lands inside the gap window (subsplitting on size overflow),
// otherwise close the tail and open a fresh chunk.
function mergeMessage (channelId, messageId, ts) {
  const last = getLastChunk(channelId)
  if (!last) {
    insertChunk(channelId, messageId, messageId, 1)
    log.debug(`[chunk] ${channelId}: opened chunk at ${messageId}`)
    return
  }
  const gap = ts - SnowflakeUtil.timestampFrom(last.last_message_id)
  if (gap > GAP_MS) {
    if (last.open === 1) setChunkOpen(last.id, 0)
    insertChunk(channelId, messageId, messageId, 1)
    log.debug(`[chunk] ${channelId}: new chunk at ${messageId}`)
    return
  }
  // inside the window but the tail was already settled (async ingest lag):
  // reopen it and drop its embedding so it re-embeds on the next pass
  if (last.open === 0) {
    setChunkOpen(last.id, 1)
    setChunkEmbedding(last.id, null)
  }
  // a delayed re-ingest (the live embed refetch) can be older than the tail's
  // newest message: it already sits inside the chunk's range, and extending
  // would shrink last_message_id backwards
  if (ts < SnowflakeUtil.timestampFrom(last.last_message_id)) return
  extendChunk(last.id, messageId)
  const ids = [
    last.first_message_id,
    ...getMessages(channelId, { after: last.first_message_id, before: messageId, fields: ['id'] }).map((r) => r.id),
    messageId
  ]
  if (ids.length <= MAX_MESSAGES) {
    log.debug(`[chunk] ${channelId}: appended ${messageId} to chunk ${last.id}`)
    return
  }
  const pieces = subsplit(ids)
  deleteChunk(last.id)
  for (let i = 0; i < pieces.length; i++) {
    insertChunk(channelId, pieces[i][0], pieces[i][pieces[i].length - 1], i === pieces.length - 1 ? 1 : 0)
  }
  log.debug(`[chunk] ${channelId}: subsplit chunk ${last.id} into ${pieces.length}`)
}

// Initial pass: draw chunk boundaries on each channel's ordered id list -
// times derive from the snowflakes, so no content is ever read. Channels
// that already have rows (restart) replay everything newer than the last
// chunk through the live merge path, covering downtime catch-up.
export function syncChunks () {
  for (const channelId of getMessageChannelIds()) {
    const last = getLastChunk(channelId)
    if (last) {
      for (const row of getMessages(channelId, { after: last.last_message_id, fields: ['id'] })) {
        mergeMessage(channelId, row.id, SnowflakeUtil.timestampFrom(row.id))
      }
      log.progress.refresh()
      continue
    }
    const ids = getMessages(channelId, { fields: ['id'] }).map((r) => r.id)
    if (!ids.length) continue
    const starts = [0]
    for (let i = 1; i < ids.length; i++) {
      if (SnowflakeUtil.timestampFrom(ids[i]) - SnowflakeUtil.timestampFrom(ids[i - 1]) > GAP_MS) starts.push(i)
    }
    let count = 0
    for (let s = 0; s < starts.length; s++) {
      for (const piece of subsplit(ids.slice(starts[s], starts[s + 1] ?? ids.length))) {
        insertChunk(channelId, piece[0], piece[piece.length - 1], 0)
        count++
      }
    }
    // the tail accepts live appends only while inside the gap window
    const tail = getLastChunk(channelId)
    if (Date.now() - SnowflakeUtil.timestampFrom(tail.last_message_id) < GAP_MS) setChunkOpen(tail.id, 1)
    log.info(`[chunk] ${channelId}: ${ids.length} messages -> ${count} chunks`)
    log.progress.refresh()
  }
}

// live messages arriving before the initial pass ran are covered by it
export function attachChunk (bus) {
  bus.on('message:ingested', (msg) => {
    try {
      mergeMessage(msg.channelId, msg.id, msg.createdTimestamp)
    } catch (err) {
      log.error('[chunk] live chunking failed:', err.message)
      return
    }
    log.progress.refresh()
    bus.emit('message:chunked', msg)
  })
}
