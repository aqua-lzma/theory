import 'dotenv/config'
import { EventEmitter } from 'node:events'
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js'
import { initDb } from './lib/db.js'
import { log } from './lib/log.js'
import { attachMessages } from './lib/scrape/live.js'
import { syncMessages } from './lib/scrape/backfill.js'
import { attachChunk, syncChunks } from './lib/embed/chunk.js'
import { attachEmbed, syncEmbeds } from './lib/embed/embed.js'
import { attachRag } from './lib/rag.js'

if (!process.env.DISCORD_TOKEN || !process.env.GUILD_ID) {
  log.error('Set DISCORD_TOKEN and GUILD_ID in .env')
  process.exit(1)
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel]
})

initDb()

client.on('rateLimited', (info) => log.warn('[rate-limit]', info.timeDelay ?? info.limit ?? info))
client.on('invalidRequestWarning', (info) => log.warn('[invalid-request-warnings]', info.count))

client.once(Events.ClientReady, async () => {
  log.info(`--- Logged in as ${client.user.tag} ---`)
  const guild = await client.guilds.fetch(process.env.GUILD_ID)

  const bus = new EventEmitter()
  attachMessages(client, bus)

  try {
    await syncMessages(guild)
    await syncChunks()
    attachChunk(bus)
    await syncEmbeds(client)
    attachEmbed(client, bus)
    attachRag(client, bus)
  } catch (err) {
    log.error('startup pipeline failed:', err.message)
    process.exit(1)
  }
})

client.login(process.env.DISCORD_TOKEN)
