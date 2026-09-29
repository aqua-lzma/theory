import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { MessageType, MessageReferenceType, StickerFormatType } from 'discord.js'
import { embedMedia } from './scrape/embeds.js'

let db = null

export function initDb (file = 'data/database.db') {
  mkdirSync(path.dirname(file), { recursive: true })
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT,
      mentions TEXT,
      reference TEXT,
      media TEXT,
      reactions TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

    -- the cursor queries compare snowflakes numerically (CAST), which the TEXT
    -- index above can't serve - this one must stay in sync with those CAST
    -- expressions in getMessages or the queries silently fall back to scans
    CREATE INDEX IF NOT EXISTS idx_messages_channel_num
      ON messages(channel_id, CAST(id AS INTEGER));

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      nickname TEXT,
      avatar_url TEXT,
      roles TEXT,
      joined_at TEXT,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      first_message_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      open INTEGER NOT NULL DEFAULT 0,
      embedding TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_channel ON chunks(channel_id, id);

    CREATE TABLE IF NOT EXISTS media_descriptions (
      hash TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL
    );
  `)
}

// The unified user object is whatever discord.js hands over: a GuildMember
// (detected via its roles manager) supersedes a bare User, whose fields are
// still reachable through member.user. If member nickname is present use
// that, otherwise default to user nickname.
export function upsertUser (user) {
  if (!user) return
  const member = user.roles ? user : null
  const author = member ? member.user : user
  if (member) {
    db.prepare(`
      INSERT INTO users (id, username, nickname, avatar_url, roles, joined_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        nickname = excluded.nickname,
        avatar_url = excluded.avatar_url,
        roles = excluded.roles,
        joined_at = COALESCE(excluded.joined_at, joined_at),
        status = COALESCE(excluded.status, status)
    `).run(
      author.id,
      author.username ?? null,
      member.displayName ?? null,
      author.displayAvatarURL(),
      JSON.stringify(
        [...member.roles.cache.values()].filter((r) => r.name !== '@everyone').map((r) => r.name)
      ),
      member.joinedTimestamp ? new Date(member.joinedTimestamp).toISOString() : null,
      member.presence?.status ?? null
    )
  } else {
    // no member data available -> only seed the row if absent
    db.prepare(`
      INSERT INTO users (id, username, nickname, avatar_url, roles)
      VALUES (?, ?, ?, ?, '[]')
      ON CONFLICT(id) DO NOTHING
    `).run(
      author.id,
      author.username ?? null,
      null,
      author.displayAvatarURL()
    )
  }
}

const SYSTEM_PLACEHOLDERS = {
  [MessageType.UserJoin]: '[Joined the server]',
  [MessageType.ChannelPinnedMessage]: '[Pinned a message]',
  [MessageType.ThreadCreated]: '[Started a thread]'
}

export function upsertMessage (msg, member = msg.member ?? null) {
  upsertUser(member ?? msg.author)
  // mentioned users are seeded (bare users, no member data) so their mention
  // markup can resolve to names at render time even if they never spoke here
  for (const user of msg.mentions.users.values()) upsertUser(user)

  // forwarded messages carry the original content/media in a snapshot
  const snapshot = msg.messageSnapshots?.first?.() ?? msg.messageSnapshots?.values()?.next()?.value
  // forwarded rows normalize media from the snapshot instead of the forward shell
  const source = snapshot ?? msg

  const content = snapshot
    ? snapshot.content ?? null
    : msg.system
      ? SYSTEM_PLACEHOLDERS[msg.type] ?? `[System: ${msg.type}]`
      : msg.content ?? null

  // embed normalization and the sole-link hiding decision live in the
  // scrape dir: db.js only stores what render will read back
  const embedded = embedMedia(content, source.embeds)

  const reference = msg.reference
    ? {
        type: msg.reference.type === MessageReferenceType.Forward ? 'forward' : 'reply',
        messageId: msg.reference.messageId,
        channelId: msg.reference.channelId
      }
    : null

  // hash/description are filled in asynchronously after the first insert, so
  // a re-upsert (edit, reaction refresh, embed refetch) must carry them over
  // by url instead of clobbering them with nulls
  const prevByUrl = new Map(
    JSON.parse(db.prepare('SELECT media FROM messages WHERE id = ?').get(msg.id)?.media ?? '[]')
      .filter((m) => m.url != null).map((m) => [m.url, m])
  )

  const media = []
  for (const a of (source.attachments?.values() ?? [])) {
    const ct = a.contentType ?? ''
    const type = ct.startsWith('image/gif')
      ? 'gif'
      : ct.startsWith('image/')
        ? 'image'
        : ct.startsWith('video/')
          ? 'video'
          : ct.startsWith('audio/')
            ? 'audio'
            : ct.startsWith('text/')
              ? 'text'
              : null
    if (type) media.push({ type, url: a.url })
  }
  media.push(...embedded.media)
  // animated sticker formats (apng/lottie/gif) carry the gif label: they are
  // silent, and the describe prompt relies on that to suppress hallucinated audio
  for (const s of (source.stickers?.values() ?? [])) {
    media.push({ type: s.format === StickerFormatType.PNG ? 'image' : 'gif', url: s.url })
  }
  for (const m of media) {
    const prev = prevByUrl.get(m.url)
    if (!prev) continue
    m.hash = prev.hash ?? null
    if (m.description == null) m.description = prev.description ?? null
  }

  const reactions = [...msg.reactions.cache.values()].map((r) => ({
    emoji: r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name,
    count: r.count
  }))

  db.prepare(`
    INSERT INTO messages (id, channel_id, author_id, content, mentions, reference, media, reactions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      mentions = excluded.mentions,
      reference = excluded.reference,
      media = excluded.media,
      reactions = excluded.reactions
  `).run(
    msg.id,
    msg.channelId,
    msg.author.id,
    embedded.content,
    JSON.stringify({
      roles: Object.fromEntries(msg.mentions.roles.map((role) => [role.id, role.name])),
      channels: Object.fromEntries(msg.mentions.channels.map((channel) => [channel.id, channel.name]))
    }),
    reference ? JSON.stringify(reference) : null,
    JSON.stringify(media),
    JSON.stringify(reactions)
  )
}

export function getOldestMessageId (channelId) {
  const row = db.prepare('SELECT MIN(id) AS id FROM messages WHERE channel_id = ?').get(channelId)
  return row?.id ?? null
}

export function getNewestMessageId (channelId) {
  const row = db.prepare('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?').get(channelId)
  return row?.id ?? null
}

// Per-channel pipeline stats for the status table: message count, chunk
// count, and embedded count (non-null embedding paths) in one map.
export function getChannelStats () {
  const out = new Map()
  for (const r of db.prepare('SELECT channel_id, COUNT(*) AS messages FROM messages GROUP BY channel_id').all()) {
    out.set(r.channel_id, { messages: r.messages, chunks: 0, embedded: 0 })
  }
  for (const r of db.prepare('SELECT channel_id, COUNT(*) AS chunks, COUNT(embedding) AS embedded FROM chunks GROUP BY channel_id').all()) {
    const row = out.get(r.channel_id) ?? { messages: 0, chunks: 0, embedded: 0 }
    row.chunks = r.chunks
    row.embedded = r.embedded
    out.set(r.channel_id, row)
  }
  return out
}

export function getMessageChannelIds () {
  return db.prepare('SELECT DISTINCT channel_id FROM messages').all().map((r) => r.channel_id)
}

// Snowflake ids are compared as integers: as strings their lexicographic order
// breaks the moment Discord's ids grow another digit.
const MESSAGE_COLUMNS = {
  id: 'm.id',
  channel_id: 'm.channel_id',
  author_id: 'm.author_id',
  content: 'm.content',
  mentions: 'm.mentions',
  reference: 'm.reference',
  media: 'm.media',
  reactions: 'm.reactions',
  username: 'u.username',
  nickname: 'u.nickname',
  author: 'COALESCE(u.nickname, u.username, m.author_id) AS author'
}
const DEFAULT_FIELDS = Object.keys(MESSAGE_COLUMNS)
const USER_FIELDS = new Set(['username', 'nickname', 'author'])

function messageSelect (fields) {
  const columns = fields.map((f) => MESSAGE_COLUMNS[f]).join(', ')
  const join = fields.some((f) => USER_FIELDS.has(f)) ? ' LEFT JOIN users u ON u.id = m.author_id' : ''
  return `SELECT ${columns} FROM messages m${join}`
}

// The single message reader: `before`/`after` are exclusive snowflake cursors,
// `limit` keeps the rows nearest the bounded side (used for fetching overlaps),
// `fields` picks columns from MESSAGE_COLUMNS (id-only queries skip the users
// join). Rows always come back ascending.
export function getMessages (channelId, { before, after, limit, fields = DEFAULT_FIELDS } = {}) {
  const where = ['m.channel_id = ?']
  const params = [channelId]
  if (after != null) {
    where.push('CAST(m.id AS INTEGER) > CAST(? AS INTEGER)')
    params.push(after)
  }
  if (before != null) {
    where.push('CAST(m.id AS INTEGER) < CAST(? AS INTEGER)')
    params.push(before)
  }
  const descending = limit != null && before != null && after == null
  const rows = db.prepare(`
    ${messageSelect(fields)}
    WHERE ${where.join(' AND ')}
    ORDER BY CAST(m.id AS INTEGER) ${descending ? 'DESC' : 'ASC'}${limit != null ? ' LIMIT ?' : ''}
  `).all(...params, ...(limit != null ? [limit] : []))
  return descending ? rows.reverse() : rows
}

export function getMessage (messageId) {
  return db.prepare(`${messageSelect(DEFAULT_FIELDS)} WHERE m.id = ?`).get(messageId) ?? null
}

// Mention label lookup for rendering: id -> COALESCE(nickname, username, id),
// matching the author labels, so <@id> renders as the display name a client
// user sees. Empty id list skips the query entirely.
export function getUsers (ids) {
  if (!ids.length) return new Map()
  return new Map(
    db.prepare(`
      SELECT id, COALESCE(nickname, username, id) AS label FROM users
      WHERE id IN (${ids.map(() => '?').join(', ')})
    `).all(...ids).map((r) => [r.id, r.label])
  )
}

export function getMediaDescription (hash) {
  return db.prepare('SELECT * FROM media_descriptions WHERE hash = ?').get(hash) ?? null
}

export function upsertMediaDescription (hash, type, description) {
  db.prepare(`
    INSERT INTO media_descriptions (hash, type, description)
    VALUES (?, ?, ?)
    ON CONFLICT(hash) DO NOTHING
  `).run(hash, type, description)
}

export function setMessageMediaDesc (messageId, url, hash, description) {
  const media = JSON.parse(db.prepare('SELECT media FROM messages WHERE id = ?').get(messageId)?.media ?? '[]')
  for (const m of media) {
    if (m.url === url) {
      m.hash = hash
      m.description = description
    }
  }
  db.prepare('UPDATE messages SET media = ? WHERE id = ?').run(JSON.stringify(media), messageId)
}

export function insertChunk (channelId, firstMessageId, lastMessageId, open = 0) {
  return Number(db.prepare('INSERT INTO chunks (channel_id, first_message_id, last_message_id, open) VALUES (?, ?, ?, ?)')
    .run(channelId, firstMessageId, lastMessageId, open).lastInsertRowid)
}

export function extendChunk (chunkId, lastMessageId) {
  db.prepare('UPDATE chunks SET last_message_id = ? WHERE id = ?').run(lastMessageId, chunkId)
}

export function deleteChunk (chunkId) {
  db.prepare('DELETE FROM chunks WHERE id = ?').run(chunkId)
}

export function setChunkOpen (chunkId, open) {
  db.prepare('UPDATE chunks SET open = ? WHERE id = ?').run(open, chunkId)
}

export function setChunkEmbedding (chunkId, embedding) {
  db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(embedding, chunkId)
}

export function getLastChunk (channelId) {
  return db.prepare('SELECT * FROM chunks WHERE channel_id = ? ORDER BY id DESC LIMIT 1').get(channelId) ?? null
}

export function getOpenChunks () {
  return db.prepare('SELECT * FROM chunks WHERE open = 1').all()
}

export function getUnembeddedClosedChunks () {
  return db.prepare('SELECT * FROM chunks WHERE open = 0 AND embedding IS NULL ORDER BY id').all()
}
