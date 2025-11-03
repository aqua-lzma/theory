import { existsSync, readFileSync, writeFileSync } from 'fs'
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { GoogleGenAI } from '@google/genai'

const models = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]

const TRUNCATE_LENGTH = 50
const MAX_HISTORY_LENGTH = 2000
const MIN_HISTORY_LENGTH = 1000
const MESSAGE_CHANCE = 1 / 400

const config = JSON.parse(readFileSync('config.json'))
const sysPrompt = readFileSync('prompt.txt', 'utf8')
const summaryPrompt = readFileSync('summaryPrompt.txt', 'utf8')
const safetySettings = [
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' }
]

const ai = new GoogleGenAI({ apiKey: config.gemini_token })
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

client.login(config.discord_token)
client.on('clientReady', () => {
  console.log('hi . . .')
})

function loadMessages (guildId) {
  const path = `messages/${guildId}.json`
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'))
  return []
}

function loadMemory (guildId) {
  const path = `memory/${guildId}.txt`
  if (existsSync(path)) return readFileSync(path, 'utf8')
  return '[No previous memory]'
}

function formatDate (date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function truncateMessage (message, length = TRUNCATE_LENGTH) {
  if (message.length > length) {
    return `${message.slice(0, length - 3)}...`
  }
  return message
}

function cleanContent (message) {
  let content = message.content

  ;(message.mentions.users ?? []).forEach(user => {
    const member = message.guild?.members.cache.get(user.id)
    const displayName = member?.displayName || user.username
    content = content.replace(new RegExp(`<@${user.id}>`, 'g'), `@${displayName}`)
  })

  ;(message.mentions.roles ?? []).forEach(role => {
    content = content.replace(new RegExp(`<@&${role.id}>`, 'g'), `@${role.name}`)
  })

  ;(message.mentions.channels ?? []).forEach(channel => {
    content = content.replace(new RegExp(`<#${channel.id}>`, 'g'), `#${channel.name}`)
  })

  return content
}

function readableHistory (messages) {
  let out = '[MESSAGES]\n'
  for (const message of messages) {
    out += `#${message.channel}\n`
    if (message.reply_to != null) {
      out += `[REPLY @${message.reply_to.author}] "${message.reply_to.message}":\n`
    }
    out += `[${message.author}] ${message.created}\n`
    out += `${message.message}\n`
    if (message.attachments?.length > 0) out += `${JSON.stringify(message.attachments)}\n`
    if (message.reactions.length > 0) {
      let reactStr = message.reactions.map(({ user, emoji }) => `${user}: ${emoji}`)
      reactStr = reactStr.join(', ')
      out += `[REACTIONS]\n${reactStr}\n`
    }
    out += '---\n'
  }
  return out
}

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return
  if (!message.guild) return

  let messages = loadMessages(message.guild.id)

  const entry = {
    id: message.id,
    channel: message.channel.name,
    author: message.member.nickname ?? message.author.displayName,
    created: formatDate(message.createdAt),
    message: cleanContent(message),
    attachments: message.attachments.map(i => i.url.split('?')[0]),
    reactions: []
  }
  if (message.reference != null) {
    const reply = await message.fetchReference()
    entry.reply_to = {
      author: reply.member.nickname ?? reply.author.displayName,
      message: truncateMessage(cleanContent(reply))
    }
  }
  messages.push(entry)
  writeFileSync(`messages/${message.guild.id}.json`, JSON.stringify(messages, null, 2), 'utf8')
  console.log(`Messages <${message.guild.id}>: ${messages.length}`)

  const contents = readableHistory(messages)
  writeFileSync(`readable/${message.guild.id}.log`, contents, 'utf8')

  if (Math.random() < MESSAGE_CHANCE || (message.mentions.has(client.user) && message.member.roles.cache.has('1151660660560764938'))) {
    try {
      await message.channel.sendTyping()
    } catch (e) {
      console.log('Failed to send typing indicator:', e)
    }

    const memory = loadMemory(message.guild.id)
    let response
    for (const model of models) {
      try {
        response = await ai.models.generateContent({
          model,
          config: {
            systemInstruction: sysPrompt + memory,
            safetySettings,
            temperature: 0.9
          },
          contents
        })
        break
      } catch (e) {
        console.log(`Rate limit on ${model} for message generation . . .`)
        if (model === models.at(-1)) return
      }
    }
    console.log(JSON.stringify(response.usageMetadata))

    try {
      const botMessage = await message.channel.send(response.text)
      messages = loadMessages(message.guild.id)
      messages.push({
        id: botMessage.id,
        channel: botMessage.channel.name,
        author: botMessage.author.displayName,
        created: formatDate(botMessage.createdAt),
        message: response.text,
        reactions: []
      })
      writeFileSync(`messages/${message.guild.id}.json`, JSON.stringify(messages, null, 2), 'utf8')
    } catch (e) {
      console.log('Failed to send response:', e)
    }
  }

  messages = loadMessages(message.guild.id)
  if (messages.length > MAX_HISTORY_LENGTH) {
    const toMemorise = messages.slice(0, messages.length - MIN_HISTORY_LENGTH)
    const trimmed = messages.slice(messages.length - MIN_HISTORY_LENGTH)
    const contents = readableHistory(toMemorise)
    writeFileSync(`messages/${message.guild.id}.json`, JSON.stringify(trimmed, null, 2), 'utf8')
    const memory = loadMemory(message.guild.id)
    try {
      let response
      for (const model of models) {
        try {
          response = await ai.models.generateContent({
            model,
            config: {
              systemInstruction: summaryPrompt + memory,
              safetySettings
            },
            contents
          })
          break
        } catch (e) {
          console.log(`Rate limit on ${model} for memory generation . . `)
          if (model === models.at(-1)) {
            messages = loadMessages(message.guild.id)
            messages.unshift(...toMemorise)
            writeFileSync(`messages/${message.guild.id}.json`, JSON.stringify(messages, null, 2), 'utf8')
            return
          }
        }
      }
      console.log('Memorise finished . . .')
      writeFileSync(`memory_history/${message.guild.id} - ${(new Date()).getTime()}.txt`, memory, 'utf8')
      writeFileSync(`memories/${message.guild.id}.txt`, response.text, 'utf8')
    } catch (e) {
      console.error('Failed to generate memory:', e)
    }
  }
})

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (oldMessage.guild == null) return

  const messages = loadMessages(oldMessage.guild.id)

  const messageEntry = messages.find(message => message.id === oldMessage.id)
  if (messageEntry != null) messageEntry.message = cleanContent(newMessage)

  writeFileSync(`messages/${oldMessage.guild.id}.json`, JSON.stringify(messages, null, 2), 'utf8')
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
  const messages = loadMessages(reaction.message.guild.id)
  const message = messages.find(message => message.id === reaction.message.id)
  if (message != null) {
    if (message.reactions == null) message.reactions = []
    message.reactions.push({
      emoji: String(reaction.emoji),
      user: name
    })
  }

  writeFileSync(`messages/${reaction.message.guild.id}.json`, JSON.stringify(messages, null, 2), 'utf8')
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
  const messages = loadMessages(reaction.message.guild.id)
  const message = messages.find(message => message.id === reaction.message.id)
  if (message != null && message.reactions != null) {
    message.reactions = message.reactions.filter(entry =>
      entry.user !== name || entry.emoji !== String(reaction.emoji)
    )
  }

  writeFileSync(`messages/${reaction.message.guild.id}.json`, JSON.stringify(messages, null, 2), 'utf8')
})
