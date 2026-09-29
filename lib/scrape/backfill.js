import { ChannelType } from 'discord.js'
import { upsertMessage, getOldestMessageId, getNewestMessageId, getChannelMessageCount } from '../db.js'
import { log } from '../log.js'

// Store a batch as soon as it arrives, resolving members that didn't ship
// with the payload: one fetch per unique author, started eagerly. Regular
// history/live payloads almost always carry member data, so this is the rare
// path (webhooks, users who left, etc.).
async function storeBatch (guild, batch) {
  const pending = new Map()
  for (const msg of batch.values()) {
    if (!msg.member && !pending.has(msg.author.id)) {
      pending.set(msg.author.id, guild.members.fetch(msg.author.id).catch(() => null))
    }
  }
  for (const msg of batch.values()) {
    upsertMessage(msg, msg.member ?? (await pending.get(msg.author.id)) ?? null)
  }
}

// Forward pass: walk messages newer than the newest stored id, until empty.
// Catches up on anything sent while the scraper was down.
async function catchUp (guild, channel, onProgress) {
  let after = getNewestMessageId(channel.id)
  if (!after) return
  let batches = 1
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, after })
    if (!batch.size) return
    await storeBatch(guild, batch)
    after = batch.last().id
    onProgress(batches)
    batches++
  }
}

// Backward pass: walk messages older than the oldest stored id, until empty/short.
// A fresh channel starts with no oldest id and paginates to the very beginning.
async function backfill (guild, channel, onProgress) {
  let before = getOldestMessageId(channel.id)
  let batches = 1
  for (;;) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    })
    if (!batch.size) return
    await storeBatch(guild, batch)
    onProgress(batches)
    if (batch.size < 100) return
    before = batch.last().id
    batches++
  }
}

async function scrapeChannel (guild, channel) {
  // threads are always short; scrape them but keep them out of the progress table
  const isThread = channel.isThread()
  const noProgress = () => {}
  const totalMessages = () => getChannelMessageCount(channel.id)

  if (isThread) {
    await catchUp(guild, channel, noProgress)
    await backfill(guild, channel, noProgress)
    return
  }

  const name = channel.name ?? channel.id
  let offsetBatches = 0
  let lastBatches = 0
  await catchUp(guild, channel, (batches) => {
    offsetBatches = batches
    lastBatches = batches
    log.progress.update(channel.id, name, 'catch-up', batches, totalMessages())
  })
  await backfill(guild, channel, (batches) => {
    lastBatches = offsetBatches + batches
    log.progress.update(channel.id, name, 'backfill', lastBatches, totalMessages())
  })
  log.progress.done(channel.id, name, lastBatches, totalMessages())
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
