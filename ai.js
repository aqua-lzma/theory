
import { readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'

import { OpenRouter } from '@openrouter/sdk'
import { JSONFileSyncPreset } from 'lowdb/node'

const config = JSON.parse(readFileSync('config.json'))
const descdb = new JSONFileSyncPreset('descdb.json', {})

const textModels = [
  'tngtech/deepseek-r1t2-chimera:free'
]
const memoryModels = [
  'tngtech/deepseek-r1t2-chimera:free'
]
const descModels = [
  'amazon/nova-2-lite-v1:free',
  'google/gemma-3-27b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free'
]

const prompt = readFileSync('prompts/prompt.txt', 'utf8')
const memoryPrompt = readFileSync('prompts/memoryPrompt.txt', 'utf8')

// Initialize OpenRouter client with your token (set config.openrouter_token)
const openRouter = new OpenRouter({
  apiKey: config.openrouter_token,
})

function formatDate (date) {
  date = new Date(date)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

export function readableHistory (messages) {
  messages.sort((a, b) => new Date(a.created) - new Date(b.created))
  let out = '[MESSAGES]\n'
  for (const message of messages) {
    out += `#${message.channel}\n`
    if (message.reply_to != null) {
      out += `[REPLY @${message.reply_to.author}] ${message.reply_to.message}:\n`
    }
    out += `[${message.author}] ${formatDate(message.created)}`
    if (message.deleted) out += ' [DELETED]'
    out += `\n${message.message}\n`
    for (const attachment of message.attachments) {
      out += `[ATTACHMENT] ${attachment}\n`
    }
    for (const embed of message.embeds) {
      out += `[EMBED]\n${embed}\n`
    }
    if (message.reactions.length > 0) {
      let reactStr = message.reactions.map(({ user, emoji }) => `@${user}: ${emoji}`)
      reactStr = reactStr.join(', ')
      out += `[REACTIONS]\n${reactStr}\n`
    }
    out += '---\n'
  }
  return out
}

/** @param {import('lowdb').LowSync} db */
export async function generateMessage (db) {
  const memory = readFileSync('prompts/memory.txt', 'utf8')
  const contents = readableHistory(db.data.messages)

  const response = await openRouter.chat.send({
    models: textModels,
    temperature: 0.9,
    messages: [
      { role: 'system', content: `${prompt}\n${memory}` },
      { role: 'user',   content: contents }
    ]
  })

  console.log('Generate', response.usage)
  return response.choices[0].message.content.trim()
}

/** @param {import('lowdb').LowSync} db */
export async function memorise (db) {
  const memory = readFileSync('prompts/memory.txt', 'utf8')

  let toMemorise, trimmed
  db.update(data => {
    toMemorise = data.messages.slice(0, data.messages.length - config.min_history)
    trimmed    = data.messages.slice(data.messages.length - config.min_history)
    data.messages = trimmed
  })

  const contents = readableHistory(toMemorise)

  try {
    const response = await openRouter.chat.send({
      models: memoryModels,
      messages: [
        { role: 'system', content: `${memoryPrompt}${memory}` },
        { role: 'user',   content: contents }
      ],
    })

    console.log('Memorise', response.usage)

    writeFileSync(`memory_history/${(new Date()).getTime()}.txt`, memory, 'utf8')
    writeFileSync('prompts/memory.txt', response.choices[0].message.content, 'utf8')
    return
  } catch (e) {
    db.update(({ messages }) => { messages.unshift(...toMemorise) })
    console.error('Failed to memorise:', e)
  }
}

export async function describe (type, mimeType, base64) {
  const hash = createHash('sha256').update(base64).digest('base64')
  if (hash in descdb.data) {
    console.log('Cached describe')
    return descdb.data[hash]
  }

  try {
    const content = [
      { type: 'text', text: `Concisely summarise this ${type} in 3 sentences.` }
    ]
    if (type === 'image') content.push({
      type: 'image_url',
      imageUrl: { url: `data:${mimeType};base64,${base64}` }
    })
    if (type === 'video') content.push({
      type: 'video_url',
      videoUrl: { url: `data:${mimeType};base64,${base64}` }
    })
    if (type === 'audio') content.push({
      type: 'input_audio',
      inputAudio: { data: base64, format: mimeType.split('/')[1] }
    })
    const response = await openRouter.chat.send({
      models: descModels,
      max_tokens: 200,
      messages: [{ role: 'user', content }]
    })

    console.log('Describe', response.usage)
    const text = response.choices[0].message.content.trim().replace(/\n/g, ' ')
    descdb.update(db => { db[hash] = text })
    return text
  } catch (error) {
    console.log('Failed describing:', error)
    return '[Error describing media]'
  }
}
