import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SnowflakeUtil } from 'discord.js'
import {
  getLastChunk,
  getMessages,
  getOpenChunks,
  getUnembeddedClosedChunks,
  setChunkEmbedding,
  setChunkOpen
} from '../db.js'
import { log } from '../log.js'
import { GAP_MS } from './chunk.js'
import { renderChunk } from '../render.js'

const OVERLAP_MESSAGES = 5

// channel names come from the api rather than any cache: fetched once per
// channel id, unfetchable channels (deleted, no access) fall back to the id -
// the failed fetch is cached too, so they stop re-fetching per chunk
const channels = new Map()

const scan = async (client) => {
  // lazy tail settlement: a chunk is complete exactly when no future
  // message can land inside the gap window of its last one, so tails whose
  // window has already elapsed can be closed without a timer
  for (const chunk of getOpenChunks()) {
    if (Date.now() - SnowflakeUtil.timestampFrom(chunk.last_message_id) >= GAP_MS) {
      setChunkOpen(chunk.id, 0)
    }
  }

  let embedded = 0
  let waiting = 0
  for (const chunk of getUnembeddedClosedChunks()) {
    // hand the event loop back between chunks so gateway traffic (live
    // ingestion, heartbeats) keeps flowing while a backlog pass runs
    await new Promise((resolve) => setImmediate(resolve))
    // the after-overlap must be settled before embedding: either full
    // (enough following messages exist) or final (the channel's tail is no
    // longer open, so whatever exists is all there will be)
    const after = getMessages(chunk.channel_id, { after: chunk.last_message_id, limit: OVERLAP_MESSAGES })
    const tail = getLastChunk(chunk.channel_id)
    if (chunk.id !== tail.id && tail.open === 1 && after.length < OVERLAP_MESSAGES) {
      waiting++
      continue
    }
    let channel = channels.get(chunk.channel_id)
    if (channel === undefined) {
      channel = await client.channels.fetch(chunk.channel_id).catch(() => null)
      channels.set(chunk.channel_id, channel)
    }
    const name = (channel?.name ?? chunk.channel_id).replace(/[^a-zA-Z0-9-_]/g, '_')
    const file = path.join('data', 'embeddings', `${name}-${chunk.channel_id}`, `${chunk.first_message_id}.txt`)
    // the chunk's own message span is the core, but the rendered window is
    // widened by the overlaps on both sides and rendered as one transcript
    const before = getMessages(chunk.channel_id, { before: chunk.first_message_id, limit: OVERLAP_MESSAGES })
    const firstId = before.length ? before[0].id : chunk.first_message_id
    const lastId = after.length ? after[after.length - 1].id : chunk.last_message_id
    mkdirSync(path.dirname(file), { recursive: true })
    const text = renderChunk(channel ?? { id: chunk.channel_id, name: chunk.channel_id }, firstId, lastId)
    writeFileSync(file, text)
    setChunkEmbedding(chunk.id, file)
    log.debug(`[embed] wrote ${file}`)
    log.progress.chars(chunk.id, chunk.channel_id, text.length)
    embedded++
  }
  if (embedded > 0 || waiting > 0) log.info(`[embed] pass: ${embedded} embedded, ${waiting} waiting`)
}

// one pass at a time: triggers landing mid-pass collapse into a single rerun
// once the running pass finishes, instead of concurrent duplicate passes.
// Returns whether the pass completed, so listeners can skip message:embedded.
let scanning = false
let pending = false

const runScan = async (client) => {
  if (scanning) {
    pending = true
    return true
  }
  let ok
  do {
    pending = false
    scanning = true
    try {
      await scan(client)
      ok = true
    } catch (err) {
      log.error('[embed] pass failed:', err.message)
      ok = false
    } finally {
      scanning = false
    }
  } while (pending)
  return ok
}

export async function syncEmbeds (client) {
  await runScan(client)
}

export function attachEmbed (client, bus) {
  bus.on('message:chunked', async (msg) => {
    const ok = await runScan(client)
    if (ok) bus.emit('message:embedded', msg)
  })
}
