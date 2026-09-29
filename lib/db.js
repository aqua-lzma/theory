import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { SnowflakeUtil, MessageType, MessageReferenceType } from 'discord.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT,
  nickname TEXT,
  avatar_url TEXT,
  roles TEXT,
  created_at TEXT,
  joined_at TEXT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT,
  created_at TEXT,
  mentions TEXT,
  reference TEXT,
  media TEXT,
  reactions TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
`

export function openDb (file = 'data/database.db') {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

const UPSERT_USER_FULL = `
INSERT INTO users (id, username, nickname, avatar_url, roles, created_at, joined_at, status)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  username = excluded.username,
  nickname = excluded.nickname,
  avatar_url = excluded.avatar_url,
  roles = excluded.roles,
  created_at = excluded.created_at,
  joined_at = COALESCE(excluded.joined_at, joined_at),
  status = COALESCE(excluded.status, status)
`

const UPSERT_USER_KEEP = `
INSERT INTO users (id, username, nickname, avatar_url, roles, created_at, joined_at, status)
VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
ON CONFLICT(id) DO NOTHING
`

export function upsertUser (db, author, member) {
  if (!author) return
  const accountCreated = new Date(SnowflakeUtil.timestampFrom(author.id)).toISOString()
  if (member) {
    const roles = JSON.stringify(
      [...member.roles.cache.values()].filter((r) => r.name !== '@everyone').map((r) => r.name)
    )
    db.prepare(UPSERT_USER_FULL).run(
      author.id,
      author.username ?? null,
      member.displayName ?? null,
      author.displayAvatarURL(),
      roles,
      accountCreated,
      member.joinedTimestamp ? new Date(member.joinedTimestamp).toISOString() : null,
      member.presence?.status ?? null
    )
  } else {
    // no member data available -> only seed the row if absent
    db.prepare(UPSERT_USER_KEEP).run(
      author.id,
      author.username ?? null,
      null,
      author.displayAvatarURL(),
      '[]',
      accountCreated
    )
  }
}

const SYSTEM_PLACEHOLDERS = {
  [MessageType.UserJoin]: '[Joined the server]',
  [MessageType.ChannelPinnedMessage]: '[Pinned a message]',
  [MessageType.ThreadCreated]: '[Started a thread]'
}

const UPSERT_MESSAGE = `
INSERT INTO messages (id, channel_id, author_id, content, created_at, mentions, reference, media, reactions)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  content = excluded.content,
  created_at = excluded.created_at,
  mentions = excluded.mentions,
  reference = excluded.reference,
  media = excluded.media,
  reactions = excluded.reactions
`

export function upsertMessage (db, msg, member = msg.member ?? null) {
  upsertUser(db, msg.author, member)

  // forwarded messages carry the original content/media in a snapshot
  const snapshot = msg.messageSnapshots?.first?.() ?? msg.messageSnapshots?.values()?.next()?.value
  // forwarded rows normalize media from the snapshot instead of the forward shell
  const source = snapshot ?? msg

  const content = snapshot
    ? snapshot.content ?? null
    : msg.system
      ? SYSTEM_PLACEHOLDERS[msg.type] ?? `[System: ${msg.type}]`
      : msg.content ?? null

  const reference = msg.reference
    ? {
        type: msg.reference.type === MessageReferenceType.Forward ? 'forward' : 'reply',
        messageId: msg.reference.messageId,
        channelId: msg.reference.channelId
      }
    : null

  const media = []
  for (const a of (source.attachments?.values() ?? [])) {
    const ct = a.contentType ?? ''
    const type = ct.startsWith('image/')
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
  for (const e of (source.embeds ?? [])) {
    const imageUrl = e.image?.url ?? e.thumbnail?.url
    if (imageUrl) media.push({ type: 'image', url: imageUrl })
    else if (e.video?.url) media.push({ type: 'video', url: e.video.url })
    const text = e.description ?? e.title
    if (text) media.push({ type: 'text', url: text })
  }
  for (const s of (source.stickers?.values() ?? [])) media.push({ type: 'image', url: s.url })

  const reactions = [...msg.reactions.cache.values()].map((r) => ({
    emoji: r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name,
    count: r.count
  }))

  db.prepare(UPSERT_MESSAGE).run(
    msg.id,
    msg.channelId,
    msg.author.id,
    content,
    new Date(msg.createdTimestamp).toISOString(),
    JSON.stringify([...msg.mentions.users.keys()]),
    reference ? JSON.stringify(reference) : null,
    JSON.stringify(media),
    JSON.stringify(reactions)
  )
}

export function getOldestMessageId (db, channelId) {
  const row = db.prepare('SELECT MIN(id) AS id FROM messages WHERE channel_id = ?').get(channelId)
  return row?.id ?? null
}

export function getNewestMessageId (db, channelId) {
  const row = db.prepare('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?').get(channelId)
  return row?.id ?? null
}

export function getChannelMessageCount (db, channelId) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?').get(channelId).n
}
