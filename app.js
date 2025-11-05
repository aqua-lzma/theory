import { readFileSync, writeFileSync } from 'fs'

import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { JSONFileSyncPreset } from 'lowdb/node'

import { processMesssage } from './processMessage.js'
import { readableHistory, generateMessage, memorise } from './ai.js'
import { formatDate } from './utils.js'

const config = JSON.parse(readFileSync('config.json'))
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction
  ]
})
const db = new JSONFileSyncPreset('db.json', { messages: [] })

client.login(config.discord_token)
client.on('clientReady', () => {
  console.log('hi . . .')
})

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return
  if (message.guild == null) return

  const entry = await processMesssage(message)
  db.update(({ messages }) => {
    messages.push(entry)
  })

  if (Math.random() < 1 / config.message_chance || (message.mentions.has(client.user))) {
    try {
      await message.channel.sendTyping()
      const text = generateMessage(db)
      const botMessage = await message.channel.send(text)
      db.update(({ messages }) => {
        messages.push({
          id: botMessage.id,
          channel: botMessage.channel.name,
          author: botMessage.author.displayName,
          created: formatDate(botMessage.createdAt),
          message: text,
          reactions: []
        })
      })
    } catch (e) {
      console.log('Failed to send response:', e)
    }
  }

  writeFileSync('readable.log', readableHistory(db.data.messages), 'utf8')

  if (db.data.messages.length > config.max_history) {
    memorise(db)
  }
})

client.on('messageUpdate', async (oldMessage, newMessage) => {
  const entry = await processMesssage(newMessage)
  db.update(({ messages }) => {
    const index = messages.findIndex(({ id }) => id === oldMessage.id)
    if (index !== -1) messages[index] = entry
  })
})

client.on('messageReactionAdd', async (reaction, user) => {
  if (!reaction.message.guild) return
  if (reaction.partial) {
    try {
      await reaction.fetch()
    } catch (e) {
      return console.log('Failed to fetch reaction:', e)
    }
  }
  const member = await reaction.message.guild.members.fetch(user)
  const name = member.nickname ?? user.displayName
  db.update(({ messages }) => {
    const entry = messages.find(({ id }) => id === reaction.message.id)
    if (entry != null) {
      entry.reactions.push({ user: name, emoji: String(reaction.emoji) })
    }
  })
})

client.on('messageReactionRemove', async (reaction, user) => {
  if (!reaction.message.guild) return
  if (reaction.partial) {
    try {
      await reaction.fetch()
    } catch (e) {
      return console.log('Failed to fetch reaction:', e)
    }
  }
  const member = await reaction.message.guild.members.fetch(user)
  const name = member.nickname ?? user.displayName
  db.update(({ messages }) => {
    const entry = messages.find(({ id }) => id === reaction.message.id)
    if (entry != null) {
      entry.reactions = entry.reactions.filter(({ user, emoji }) =>
        user !== name || emoji !== String(reaction.emoji)
      )
    }
  })
})
