import { Events } from 'discord.js'
import { upsertMessage } from '../db.js'
import { log } from '../log.js'

async function handleReaction (reaction, db) {
  try {
    if (reaction.partial) reaction = await reaction.fetch()
    const msg = reaction.message.partial
      ? await reaction.message.fetch()
      : reaction.message
    // member enrichment: use the payload member when present, otherwise one
    // cache-first fetch (no-op in steady state, single REST call when cold)
    upsertMessage(db, msg, msg.member ??
      (msg.guild ? await msg.guild.members.fetch(msg.author.id).catch(() => null) : null))
  } catch (err) {
    log.error('[scrape:live] reaction handling failed:', err.message)
  }
}

export function attachLiveHandlers (client, db) {
  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guild) return
    upsertMessage(db, msg, msg.member ??
      await msg.guild.members.fetch(msg.author.id).catch(() => null))
  })

  client.on(Events.MessageUpdate, async (_old, newMsg) => {
    try {
      const msg = newMsg.partial ? await newMsg.fetch() : newMsg
      upsertMessage(db, msg, msg.member ??
        (msg.guild ? await msg.guild.members.fetch(msg.author.id).catch(() => null) : null))
    } catch (err) {
      log.error('[scrape:live] message update failed:', err.message)
    }
  })

  client.on(Events.MessageReactionAdd, (reaction) => handleReaction(reaction, db))
  client.on(Events.MessageReactionRemove, (reaction) => handleReaction(reaction, db))
}
