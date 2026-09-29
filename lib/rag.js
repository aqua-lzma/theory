import { log } from './log.js'

const chance = Number(process.env.RAG_RANDOM_CHANCE)
const RANDOM_CHANCE = Number.isFinite(chance) ? chance : 0.01

export function attachRag (client, bus) {
  log.info('[rag] enabled')

  bus.on('message:embedded', (msg) => {
    if (msg.author.bot) return
    const mention = msg.mentions.has(client.user)
    if (!mention && Math.random() >= RANDOM_CHANCE) return
    log.info(`[rag] would respond to ${msg.id} (${mention ? 'mention' : 'random'})`)
  })
}
