import { readFileSync } from 'fs'

import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { LowSync } from 'lowdb'
import { JSONFileSync } from 'lowdb/node'

import { ingestMessage, updateMessage } from './processMessage.js'
import { generateMessage, memorise } from './ai.js'
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
const db = new LowSync(new JSONFileSync('db.json'), { messages: [] })

client.login(config.discord_token)
client.on('clientReady', () => {
  console.log('hi . . .')
})

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return
  if (message.guild == null) return

  await ingestMessage(db, message)

  if (Math.random() < 1 / config.message_chance || (message.mentions.has(client.user) && message.member.roles.cache.has('1151660660560764938'))) {
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

  if (db.data.messages.length > config.max_history) {
    memorise(db)
  }
})

client.on('messageUpdate', async (oldMessage, newMessage) => {
  updateMessage(db, newMessage)
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
