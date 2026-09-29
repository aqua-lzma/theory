import { Events } from 'discord.js'
import { upsertMessage } from '../db.js'
import { log } from '../log.js'

async function handleReaction (reaction) {
  try {
    if (reaction.partial) reaction = await reaction.fetch()
    const msg = reaction.message.partial
      ? await reaction.message.fetch()
      : reaction.message
    upsertMessage(msg, msg.member ??
      (msg.guild ? await msg.guild.members.fetch(msg.author.id).catch(() => null) : null))
  } catch (err) {
    log.error('[scrape:live] reaction handling failed:', err.message)
  }
}

export function attachMessages (client, bus) {
  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guild) return
    upsertMessage(msg, msg.member ??
      await msg.guild.members.fetch(msg.author.id).catch(() => null))
    bus.emit('message:ingested', msg)
  })

  client.on(Events.MessageUpdate, async (_old, newMsg) => {
    try {
      const msg = newMsg.partial ? await newMsg.fetch() : newMsg
      upsertMessage(msg, msg.member ??
        (msg.guild ? await msg.guild.members.fetch(msg.author.id).catch(() => null) : null))
    } catch (err) {
      log.error('[scrape:live] message update failed:', err.message)
    }
  })

  client.on(Events.MessageReactionAdd, (reaction) => handleReaction(reaction))
  client.on(Events.MessageReactionRemove, (reaction) => handleReaction(reaction))
}
