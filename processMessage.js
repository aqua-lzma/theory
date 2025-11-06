import { readFileSync } from 'fs'

import axios from 'axios'

import { describe } from './ai.js'

const config = JSON.parse(readFileSync('./config.json', 'utf8'))

const imageFormats = ['image/png', 'image/jpg', 'image/jpeg', 'image/webp']
const videoFormats = [
  'video/mp4',
  'video/mpeg',
  'video/mov',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp'
]
const audioFormats = [
  'audio/wav',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac'
]

/** @param {import('discord.js').Message} message */
function cleanContent (message) {
  let content = message.content
  ;(message.mentions.users ?? []).forEach(user => {
    const member = message.guild.members.cache.get(user.id)
    const displayName = member?.nickname ?? user.displayName
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

function truncate (message, length = config.truncate_length) {
  if (message.length > length) {
    return `${message.slice(0, length - 3)}...`
  }
  return message
}

/** @param {import('discord.js').Message} message */
export async function processMesssage (message) {
  const entry = {
    id: message.id,
    channel: message.channel.name,
    author: message.member?.nickname ?? message.author.displayName,
    created: message.createdAt,
    message: cleanContent(message),
    attachments: [],
    embeds: [],
    reactions: []
  }

  if (message.reference != null) {
    const reply = await message.fetchReference()
    entry.reply_to = {
      author: reply.member?.nickname ?? reply.author.displayName,
      message: truncate(cleanContent(reply))
    }
  }

  for (const react of message.reactions.cache.values()) {
    for (const user of react.users.cache.values()) {
      const member = await message.guild.members.fetch(user)
      const name = member?.nickname ?? user.displayName
      entry.reactions.push({ user: name, emoji: String(react.emoji) })
    }
  }

  for (const attachment of message.attachments.values()) {
    let desc = attachment.contentType
    if (imageFormats.includes(attachment.contentType)) {
      const response = await axios.get(attachment.attachment, { responseType: 'arraybuffer' })
      const base64 = Buffer.from(response.data).toString('base64')
      desc = await describe('image', attachment.contentType, base64)
    }
    if (videoFormats.includes(attachment.contentType)) {
      const response = await axios.get(attachment.attachment, { responseType: 'arraybuffer' })
      const base64 = Buffer.from(response.data).toString('base64')
      desc = await describe('video and audio', attachment.contentType, base64)
    }
    if (audioFormats.includes(attachment.contentType)) {
      const response = await axios.get(attachment.attachment, { responseType: 'arraybuffer' })
      const base64 = Buffer.from(response.data).toString('base64')
      desc = await describe('audio', attachment.contentType, base64)
    }
    entry.attachments.push(desc)
  }

  if ((/https?:\/\//).test(message.content)) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    message = await message.fetch()
    for (const embed of message.embeds.values()) {
      const block = [
        embed.author?.name,
        embed.title,
        embed.description
      ]

      if (embed.image == null && embed.video == null && embed.thumbnail != null) {
        const response = await axios.get(embed.thumbnail.url, { responseType: 'arraybuffer' })
        let desc = response.headers['content-type']
        if (imageFormats.includes(desc)) {
          const base64 = Buffer.from(response.data).toString('base64')
          desc = await describe('image', response.headers['content-type'], base64)
        }
        block.push(`[THUMBNAIL] ${desc}`)
      }

      if (embed.image != null) {
        const response = await axios.get(embed.image.url, { responseType: 'arraybuffer' })
        let desc = response.headers['content-type']
        if (imageFormats.includes(desc)) {
          const base64 = Buffer.from(response.data).toString('base64')
          desc = await describe('image', response.headers['content-type'], base64)
        }
        block.push(`[IMAGE] ${desc}`)
      }

      if (embed.video != null) {
        const response = await axios.get(embed.video.url, { responseType: 'arraybuffer' })
        let desc = response.headers['content-type']
        if (videoFormats.includes(desc)) {
          const base64 = Buffer.from(response.data).toString('base64')
          desc = await describe('video and audio', response.headers['content-type'], base64)
        }
        block.push(`[VIDEO] ${desc}`)
      }

      entry.embeds.push(block.filter(i => i != null).join('\n'))
    }
  }

  return entry
}
