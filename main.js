import 'dotenv/config'
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js'
import { openDb } from './lib/db.js'
import { log } from './lib/log.js'
import { attachLiveHandlers } from './lib/scrape/live.js'
import { runBackfill } from './lib/scrape/backfill.js'

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

const db = openDb()

client.on('rateLimited', (info) => log.warn('[rate-limit]', info.timeDelay ?? info.limit ?? info))
client.on('invalidRequestWarning', (info) => log.warn('[invalid-request-warnings]', info.count))

client.once(Events.ClientReady, async () => {
  log.info(`--- Logged in as ${client.user.tag} ---`)
  const guild = await client.guilds.fetch(process.env.GUILD_ID)

  // live ingestion first so nothing is missed while history is scraped
  attachLiveHandlers(client, db)

  await runBackfill(guild, db)

  // next step goes here (live ingestion keeps running)
})

client.login(process.env.DISCORD_TOKEN)
