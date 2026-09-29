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
    log.debug('[scrape:live] message received:', msg.channel.name, msg.id)
    if (!msg.guild) return
    upsertMessage(msg, msg.member ??
      await msg.guild.members.fetch(msg.author.id).catch(() => null))
    log.debug('[scrape:live] message ingested:', msg.channel.name, msg.id)
    log.progress.refresh()
    bus.emit('message:ingested', msg)
    // link embeds unfurl asynchronously: the create payload carries none of
    // them, so url messages are re-fetched shortly after and overwritten -
    // the re-emitted event lets the describe stage pick up the embed media
    if (!/https?:\/\//.test(msg.content ?? '')) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const fresh = await msg.fetch().catch(() => null)
    if (!fresh) return
    upsertMessage(fresh, fresh.member ??
      (fresh.guild ? await fresh.guild.members.fetch(fresh.author.id).catch(() => null) : null))
    bus.emit('message:ingested', fresh)
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
