import { readFileSync, writeFileSync } from 'fs'
import { GoogleGenAI } from '@google/genai'

const config = JSON.parse(readFileSync('config.json'))

const models = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]
const prompt = readFileSync('prompts/prompt.txt', 'utf8')
const memoryPrompt = readFileSync('prompts/memoryPrompt.txt', 'utf8')
const safetySettings = [
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' }
]

const ai = new GoogleGenAI({ apiKey: config.gemini_token })

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
  for (const model of models) {
    try {
      const memory = readFileSync('prompts/memory.txt', 'utf8')
      const contents = readableHistory(db.data.messages)
      const response = await ai.models.generateContent({
        model,
        config: {
          systemInstruction: prompt + '\n' + memory,
          safetySettings,
          temperature: 0.9
        },
        contents
      })
      console.log('Generate:', response.usageMetadata)
      return response.text
    } catch (error) {
      if (error.status === 429) {
        console.log(`Rate limit on ${model} for message generation . . .`)
        if (model === models.at(-1)) throw Error('Rate limited.')
      } else {
        throw error
      }
    }
  }
}

/** @param {import('lowdb').LowSync} db */
export async function memorise (db) {
  const memory = readFileSync('prompts/memory.txt', 'utf8')
  let toMemorise, trimmed
  db.update(data => {
    toMemorise = data.messages.slice(0, data.messages.length - config.min_history)
    trimmed = data.messages.slice(data.messages.length - config.min_history)
    data.messages = trimmed
  })
  const contents = readableHistory(toMemorise)
  for (const model of models) {
    // Dont make memory blocks using flash-lite, just try again later
    if (model === models.at(-1)) {
      return db.update(({ messages }) => { messages.unshift(...toMemorise) })
    }
    try {
      const response = await ai.models.generateContent({
        model,
        config: {
          systemInstruction: memoryPrompt + memory,
          safetySettings
        },
        contents
      })
      console.log('Memorise:', response.usageMetadata)
      writeFileSync(`memory_history/${(new Date()).getTime()}.txt`, memory, 'utf8')
      writeFileSync('prompts/memory.txt', response.text, 'utf8')
    } catch (error) {
      if (error.status === 429) {
        console.log(`Rate limit on ${model} for memory generation . . `)
      } else {
        throw (error)
      }
    }
  }
}

export async function describe (type, mimeType, data) {
  while (true) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        config: {
          maxOutputTokens: 200,
          thinkingConfig: { thinkingBudget: 0 },
          safetySettings
        },
        contents: [
          { inlineData: { mimeType, data } },
          { text: `Concisely summarise this ${type} in a 3 sentences.` }
        ]
      })
      console.log('Describe:', JSON.stringify(response.usageMetadata))
      return response.text.replace(/\n/g, ' ')
    } catch (error) {
      if (error.status === 429) {
        console.log('Rate limit on describe . . .')
        await new Promise((resolve) => setTimeout(resolve, 5000))
      } else throw error
    }
  }
}
