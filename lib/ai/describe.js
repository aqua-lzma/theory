import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getMessage, getMediaDescription, setMessageMediaDesc, upsertMediaDescription } from '../db.js'
import { log } from '../log.js'
import { getFreeModels, getOpenRouter } from './client.js'

const PROMPT_FILE = 'prompts/describe-media.txt'
const MAX_BYTES = 20 * 1024 * 1024
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 15 * 60_000

// Round-robin cursor per modality: consecutive attempts rotate through the
// free models, spreading load past per-model free-tier rate limits.
const rotation = new Map()

// Describe one media entry: download, hash, cache lookup, and on a miss an
// openrouter request against a free model that accepts the input modality.
// Returns { description, hash } on success (including the 'Failed to
// download' marker for unusable bytes - no hash there), { retry: true } when
// the describe request failed and the media should be retried after backoff,
// or null when this media can never be described (unsupported content type).
export async function describeMedia (url, type) {
  let res
  try {
    res = await fetch(url)
  } catch (err) {
    log.warn(`[ai:describe] download failed (${url}): ${err.message}`)
    return { description: 'Failed to download' }
  }
  if (!res.ok) {
    log.warn(`[ai:describe] download failed (${url}): HTTP ${res.status}`)
    return { description: 'Failed to download' }
  }
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  const bytes = Buffer.from(await res.arrayBuffer())
  if (!/^(image|video|audio)\//.test(contentType)) {
    // e.g. lottie stickers resolve to application/json
    log.warn(`[ai:describe] unsupported content type ${contentType} (${url})`)
    return null
  }
  if (bytes.length > MAX_BYTES) {
    log.warn(`[ai:describe] ${url} too large to describe (${bytes.length} bytes)`)
    return { description: 'Failed to download' }
  }

  // the hash cache makes identical re-posts free: content, not url, is the key
  const hash = createHash('sha256').update(bytes).digest('hex')
  const cached = getMediaDescription(hash)
  if (cached) return { description: cached.description, hash }

  const modality = type === 'video' ? 'video' : type === 'audio' ? 'audio' : 'image'
  const models = await getFreeModels(modality)
  if (!models.length) {
    log.error(`[ai:describe] no free ${modality}-input models available`)
    return { retry: true }
  }
  const next = (rotation.get(modality) ?? 0) % models.length
  rotation.set(modality, next + 1)
  const model = models[next]

  // the prompt is re-read per call so tweaks apply without a restart; an
  // 'image'-typed gif (embeds carry no content type) upgrades to the gif label
  const prompt = readFileSync(PROMPT_FILE, 'utf8').trim()
    .replaceAll('{type}', type === 'image' && contentType === 'image/gif' ? 'gif' : type)

  const base64 = bytes.toString('base64')
  const content = [{ type: 'text', text: prompt }]
  if (type === 'audio') {
    content.push({ type: 'input_audio', inputAudio: { data: base64, format: contentType.split('/')[1] } })
  } else if (type === 'video') {
    content.push({ type: 'video_url', videoUrl: { url: `data:${contentType};base64,${base64}` } })
  } else {
    content.push({ type: 'image_url', imageUrl: { url: `data:${contentType};base64,${base64}` } })
  }

  try {
    const result = await getOpenRouter().chat.send({
      chatRequest: { model, messages: [{ role: 'user', content }], stream: false }
    })
    const raw = result.choices[0]?.message?.content
    const description = (typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.filter((p) => p?.type === 'text').map((p) => p.text).join(' ')
        : ''
    ).trim()
    if (!description) {
      log.warn(`[ai:describe] ${model} returned no content for ${url}`)
      return { retry: true }
    }
    upsertMediaDescription(hash, type, description)
    return { description, hash }
  } catch (err) {
    log.warn(`[ai:describe] ${model} failed (${url}): ${err.message}`)
    return { retry: true }
  }
}

// Media awaiting (re)description, processed serially: free-tier rate limits
// are tight, so one request at a time behind a shared exponential backoff.
const queue = []
let draining = false
let backoffUntil = 0
let backoffMs = BACKOFF_BASE_MS

async function drain () {
  try {
    while (queue.length) {
      const wait = backoffUntil - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const item = queue.shift()
      let outcome
      try {
        outcome = await describeMedia(item.url, item.type)
      } catch (err) {
        log.error(`[ai:describe] ${item.url}: ${err.message}`)
        outcome = { retry: true }
      }
      if (outcome?.description != null) {
        setMessageMediaDesc(item.messageId, item.url, outcome.hash, outcome.description)
        backoffMs = BACKOFF_BASE_MS
      } else if (outcome?.retry) {
        // describe failures (usually rate limits) leave the field null, back
        // off exponentially and requeue for a later attempt
        backoffUntil = Date.now() + backoffMs
        queue.push(item)
        log.warn(`[ai:describe] backing off ${Math.round(backoffMs / 1000)}s, ${queue.length} media queued`)
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
      }
    }
  } catch (err) {
    log.error('[ai:describe] drain crashed:', err.message)
  } finally {
    draining = false
  }
}

// Live ingests only: backfill never emits message:ingested, so archived
// history is deliberately left undescribed. Text media is its own
// description and already-described media (hash cache hit written back on a
// previous ingest) is final.
export function attachDescribe (bus) {
  bus.on('message:ingested', (msg) => {
    const media = JSON.parse(getMessage(msg.id)?.media ?? '[]')
    for (const m of media) {
      if (m.type === 'text' || m.description != null) continue
      // the embed refetch re-emits ingested before pending descriptions
      // land; skip entries already queued so nothing downloads twice
      if (queue.some((q) => q.messageId === msg.id && q.url === m.url)) continue
      queue.push({ messageId: msg.id, url: m.url, type: m.type })
    }
    if (!draining && queue.length) {
      draining = true
      drain()
    }
  })
}
