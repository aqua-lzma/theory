# theory3

Discord guild archiver: scrapes full message history plus live traffic into SQLite, then chunks and embeds it for a future RAG bot.

## Running

```sh
npm start
```

Environment (loaded via dotenv):

- `DISCORD_TOKEN` - bot token (required)
- `GUILD_ID` - guild to archive (required)
- `RAG_RANDOM_CHANCE` - probability of the rag stage reacting to any message (default `0.01`)

CLI arg:

- `--log-level=<error|warn|info|debug>` - default `info`. `debug` also enables the scrape progress table.

Data lives in `data/database.db` (SQLite, WAL mode), rendered chunks in `data/embeddings/`.

## Pipeline

`messages -> chunks -> embeds -> rag`, synced sequentially at startup, then kept flowing through live traffic:

- Startup (in `main.js`): `attachMessages` wires live ingestion first, then `syncMessages` (full history scrape), `syncChunks` (initial chunk pass), `attachChunk` (live chunking), `syncEmbeds` (initial embed pass), `attachEmbed` (live embedding) and `attachRag` run/attach in that order. A failure in any sync pass logs and exits.
- Live message: `message:ingested` (after the raw upsert) -> `message:chunked` -> `message:embedded` -> rag generation check (mention or `RAG_RANDOM_CHANCE`, log-only for now). Live messages arriving before a stage's attach are covered by that stage's sync pass; messages landing mid-sync are picked up by the next restart's replay or the next embed scan.

## Filemap

### `main.js` - entry point

Entrypoint; bootstraps and wires everything together.

- Checks `DISCORD_TOKEN`/`GUILD_ID`, runs `initDb()`, logs in the discord.js client
- On `ClientReady`: fetches the guild, creates the event bus, attaches live ingestion, then awaits `syncMessages` -> `syncChunks` -> `syncEmbeds`, attaching the chunk/embed/rag live handlers between them. Live traffic keeps flowing through the same chain afterwards.

### `lib/db.js` - SQLite persistence layer

Module singleton: `initDb(file = 'data/database.db')` opens/creates the DB, creates the parent directory, enables WAL and applies the schema (`users`, `messages`, `chunks`) into a module-private handle - no function takes the handle.

- `upsertUser(user)` - writes a user row from a single discord.js object: a GuildMember (detected via its roles manager) supersedes a bare User, whose fields are still reachable through `member.user`. With member data: full upsert (username, nickname, avatar, role names, join date, presence, `COALESCE`-style preservation of joined_at/status); without: seed-if-absent. Account/message times are not stored - they derive from the snowflake ids.
- `upsertMessage(msg, member = msg.member ?? null)` - inserts or updates a message row and upserts its author. Normalizes: forwarded-message snapshots (content and media come from the snapshot, not the forward shell), system message placeholders (`SYSTEM_PLACEHOLDERS`), attachments/embeds/stickers into a `media` JSON array, reaction counts, mention ids, reply/forward references.
- `getOldestMessageId(channelId)` / `getNewestMessageId(channelId)` - `MIN(id)`/`MAX(id)` snowflake bounds for a channel; used by the sync passes.
- `getChannelMessageCount(channelId)` - message count; used for progress display.
- `getMessages(channelId, { before, after, limit, fields })` - the single message reader. `before`/`after` are exclusive snowflake cursors (Discord fetch semantics), rows always come back ascending, `limit` keeps the rows nearest the bounded side (the embed overlaps), `fields` picks columns (the chunk stage only needs ids, which skips the users join). The joined `author` label is `COALESCE(nickname, username, author_id)`.
- `getMessage(messageId)` - single row with the author-label join; used for reply rendering and window endpoints.
- Chunk table CRUD: `insertChunk`, `extendChunk`, `deleteChunk`, `setChunkOpen`, `setChunkEmbedding`, plus reads `getMessageChannelIds`, `getLastChunk`, `getOpenChunks`, `getUnembeddedClosedChunks`. `chunks.open = 1` marks the channel tail still accepting live appends; `chunks.embedding` holds the dummy embedding artifact path (NULL = not embedded).

### `lib/log.js` - logging

Exports a single `log` singleton, imported directly (never passed through function args). Built at import time; reads `--log-level=` from `process.argv` via `parseArgs` (non-strict; invalid values fall back to `info`):

- `.error/.warn` → stderr, `.info/.debug` → stdout; each line is `<iso-timestamp> <level-padded> <message>`; `format()`-style variadic args. Messages carry their own bracket prefix (e.g. `[scrape] ...`).
- `.progress` - scrape progress API with `update(id, name, phase, batches, messages)` and `done(...)`. Active only at debug level: ANSI re-rendered table when stdout is a TTY, one plain log line per event when not, no-op otherwise.

All logging goes through this module, not `console.*`.

### `lib/scrape/live.js` - live traffic ingestion

- `attachMessages(client, bus)` - `MessageCreate`/`MessageUpdate`/reaction handlers upsert into the DB; after each new message upsert the raw `message:ingested` event is emitted on the bus for the downstream chunk stage. Update/reaction handlers only refresh the stored rows.

### `lib/scrape/backfill.js` - history scraping

- `syncMessages(guild)` - collects all scrapable channels, then scrapes them all concurrently. Per channel:
  - `catchUp` pass - paginate forward from the newest stored id (skips entirely on a fresh channel)
  - `backfill` pass - paginate backward from the oldest stored id to the very beginning.

### `lib/embed/chunk.js` - chunk stage

`syncChunks()` + `attachChunk(bus)`. Time-based chunking: a >`GAP_MS` (5 min) gap between messages ends a chunk; ranges of more than `MAX_MESSAGES` (50) messages are subsplit at their longest internal time gap (ties broken toward the midpoint), recursively.

- `syncChunks` draws chunk boundaries on each channel's ordered id list alone - times derive from the snowflakes, so no content is ever read. The channel tail is left `open` only when its last message is still inside the gap window. Channels that already have rows (restart) replay everything newer than the last chunk through the live merge path, covering downtime catch-up.
- `attachChunk` on `message:ingested`: appends to the open tail when inside the gap window, otherwise closes the tail and opens a fresh chunk. A straggler landing inside the window of a settled tail reopens it and clears its embedding. Emits `message:chunked`.

### `lib/render.js` - transcript rendering

- `renderChunk(channel, beforeId, afterId)` - renders the inclusive message window (`null` = channel start/end) as a transcript. `channel` is a `{ id, name }` object (any discord.js channel works). Consecutive messages from the same author collapse into one block; replies prefix `[Reply to @nickname]` (bare `[Reply]` when the referenced message isn't archived), forwards prefix `[Forwarded]`, media render as `[Image]`/`[Video]`/`[Audio]`/`[Text]` markers (descriptions blank for now), reactions render as counts:

```
#channel-name 2001-11-09 09:35 -> 09:37
Members: 2093847 @username (nickname), 8374658 @username
Messages:
[09:35] nickname
  TURN ON THE NEWS, THEY HIT THE FUCKING PENTAGON
[09:36] nickname
  lmao based
  [Image]
  [Reactions] :lul: x2
```

- Header timestamps are UTC and snowflake-derived; the end collapses to `HH:MM` when the window stays within one day.

### `lib/embed/embed.js` - dummy embedding stage

`syncEmbeds(client)` + `attachEmbed(client, bus)`. A scan runs once at startup and on every `message:chunked`:

- Open tails whose gap window has elapsed are lazily settled (`open = 0`) - safe because a chunk is complete exactly when no future message can land within the window of its last message, so no timer is needed.
- Closed chunks with a NULL embedding wait until their after-overlap is settled: `OVERLAP_MESSAGES` (5) following messages exist, or the channel tail is no longer open (a final chunk's partial overlap is all there will be). Channel objects come from `client.channels.fetch`, cached per id (raw id fallback for deleted/inaccessible channels).
- Ready chunks are rendered as their core window widened by up to `OVERLAP_MESSAGES` on each side - one transcript via `renderChunk` - written to `data/embeddings/<channel-name>-<channel-id>/<first-message-id>.txt`, and their `chunks.embedding` is set to the file path. The open tail stays NULL - it is never embedded while it can still grow.
- Emits `message:embedded` per message.

### `lib/rag.js` - rag stage (placeholder)

- `attachRag(client, bus)` - attached after the embed stage. On each `message:embedded` (non-bot author): `@`-mention or `Math.random() < RAG_RANDOM_CHANCE` triggers a log line saying it would respond. No LLM call yet.

## Conventions

- ESM (`"type": "module"`), Node >= 18 (uses `util.parseArgs`).
- Style enforced by `npm run lint` (see `eslint.config.js`): 2-space indent, no semicolons, single quotes, space before function parens (`function name ()`), operators at line ends.
- No single-use private helper functions: logic that runs once is inlined at its call site (this was deliberately cleaned up in `lib/db.js` and the scrape modules - don't reintroduce helpers).
- The db handle is a module singleton (`initDb`), imported directly like `log` - never passed through function args.
- DB writes are upserts; the scrape is restartable and idempotent. Snowflake ids double as sort keys (monotonic), which is why `MIN(id)`/`MAX(id)` give channel bounds.
