import { ChannelType } from 'discord.js'
import { upsertMessage, getOldestMessageId, getNewestMessageId, getMessage } from '../db.js'
import { log } from '../log.js'

// Store a batch as soon as it arrives, resolving members that didn't ship
// with the payload: one fetch per unique author, started eagerly. Regular
// history/live payloads almost always carry member data, so this is the rare
// path (webhooks, users who left, etc.).
async function storeBatch (guild, batch, label) {
  const pending = new Map()
  for (const msg of batch.values()) {
    if (!msg.member && !pending.has(msg.author.id)) {
      pending.set(msg.author.id, guild.members.fetch(msg.author.id).catch(() => null))
    }
  }
  let fresh = 0
  const sample = []
  for (const msg of batch.values()) {
    if (!getMessage(msg.id)) {
      fresh++
      if (sample.length < 5) sample.push(msg.id)
    }
    upsertMessage(msg, msg.member ?? (await pending.get(msg.author.id)) ?? null)
  }
  log.debug('[scrape:walk] %s batch=%d first=%s last=%s fresh=%d %s', label, batch.size, batch.first().id, batch.last().id, fresh, sample.join(','))
}

// Forward pass: walk messages newer than the newest stored id, until empty.
// Catches up on anything sent while the scraper was down.
async function catchUp (guild, channel, onProgress) {
  let after = getNewestMessageId(channel.id)
  if (!after) return
  let fetches = 1
  for (;;) {
    log.debug('[scrape:catchUp] %s #%d after=%s', channel.name ?? channel.id, fetches, after)
    const batch = await channel.messages.fetch({ limit: 100, after })
    if (!batch.size) return
    await storeBatch(guild, batch, `cu:${channel.name ?? channel.id}`)
    // the batch comes back newest-first: the highest stored id is batch.first(),
    // resuming from batch.last() (its oldest) only advances the cursor one
    // message per fetch and re-stores the other 99 on every iteration
    const next = batch.first().id
    if (BigInt(next) <= BigInt(after)) {
      log.error('[scrape:catchUp] %s cursor stalled (%s -> %s), aborting pass', channel.name ?? channel.id, after, next)
      return
    }
    after = next
    onProgress(fetches)
    fetches++
  }
}

// Backward pass: walk messages older than the oldest stored id, until empty/short.
// A fresh channel starts with no oldest id and paginates to the very beginning.
async function backfill (guild, channel, onProgress) {
  let before = getOldestMessageId(channel.id)
  let fetches = 1
  for (;;) {
    log.debug('[scrape:backfill] %s #%d before=%s', channel.name ?? channel.id, fetches, before)
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    })
    if (!batch.size) return
    await storeBatch(guild, batch, `bf:${channel.name ?? channel.id}`)
    onProgress(fetches)
    if (batch.size < 100) return
    const next = batch.last().id
    if (before && BigInt(next) >= BigInt(before)) {
      log.error('[scrape:backfill] %s cursor stalled (%s -> %s), aborting pass', channel.name ?? channel.id, before, next)
      return
    }
    before = next
    fetches++
  }
}

async function scrapeChannel (guild, channel) {
  // threads are always short; scrape them but keep them out of the progress table
  const isThread = channel.isThread()
  const noProgress = () => {}

  if (isThread) {
    await catchUp(guild, channel, noProgress)
    await backfill(guild, channel, noProgress)
    return
  }

  const name = channel.name ?? channel.id
  let offsetFetches = 0
  let lastFetches = 0
  // register the row up front so channels with no new traffic still appear
  log.progress.update(channel.id, name, 'sync', 0)
  await catchUp(guild, channel, (fetches) => {
    offsetFetches = fetches
    lastFetches = fetches
    log.progress.update(channel.id, name, 'sync', fetches)
  })
  await backfill(guild, channel, (fetches) => {
    lastFetches = offsetFetches + fetches
    log.progress.update(channel.id, name, 'sync', lastFetches)
  })
  log.progress.done(channel.id, name, lastFetches)
}

async function collectChannels (guild) {
  const out = []
  for (const ch of guild.channels.cache.values()) {
    const supported =
      ch.type === ChannelType.GuildText ||
      ch.type === ChannelType.GuildAnnouncement ||
      ch.type === ChannelType.GuildForum
    if (!supported) continue
    // forum channels are containers, not message sources; only their threads hold messages
    if (ch.type !== ChannelType.GuildForum) out.push(ch)
    try {
      const active = await ch.threads.fetchActive()
      out.push(...active.threads.values())
      const archived = await ch.threads.fetchArchived()
      out.push(...archived.threads.values())
    } catch {}
  }
  return out
}

export async function syncMessages (guild) {
  const channels = await collectChannels(guild)
  log.info(`[scrape] syncing ${channels.length} channels concurrently`)

  await Promise.all(channels.map(async (channel) => {
    try {
      await scrapeChannel(guild, channel)
    } catch (err) {
      log.error(`[scrape] channel ${channel.id} (${channel.name ?? 'thread'}) failed:`, err.message)
    }
  }))
  log.info('[scrape] sync complete')
}
