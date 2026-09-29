# theory3

Discord guild archiver: scrapes full message history plus live traffic into SQLite, then chunks and embeds it for a future RAG bot.

## Running

```sh
npm start
```

Environment (loaded via dotenv):

- `DISCORD_TOKEN` - bot token (required)
- `GUILD_ID` - guild to archive (required)
- `OPENROUTER_API_KEY` - OpenRouter key for media descriptions via free models (required)
- `RAG_RANDOM_CHANCE` - probability of the rag stage reacting to any message (default `0.01`)

CLI arg:

- `--log-level=<error|warn|info|debug>` - default `info`. The pipeline status table runs on any TTY, at any level; `debug` adds verbose log lines (and the non-TTY fallback of the table).

Data lives in `data/database.db` (SQLite, WAL mode), rendered chunks in `data/embeddings/`.

## Pipeline

`messages -> chunks -> embeds -> rag`, synced sequentially at startup, then kept flowing through live traffic:

- Startup (in `main.js`): `attachMessages` wires live ingestion first, then `syncMessages` (full history scrape), `syncChunks` (initial chunk pass), `attachChunk` (live chunking), `syncEmbeds` (initial embed pass), `attachEmbed` (live embedding) and `attachRag` run/attach in that order. A failure in any sync pass logs and exits.
- Live message: `message:ingested` (after the raw upsert) -> media description (async, live ingests only - backfill history is never described) and `message:chunked` -> `message:embedded` -> rag generation check (mention or `RAG_RANDOM_CHANCE`, log-only for now). Live messages arriving before a stage's attach are covered by that stage's sync pass; messages landing mid-sync are picked up by the next restart's replay or the next embed scan. Descriptions land within seconds of ingest, and embedding always waits on the after-overlap settling (more messages or a gap elapsed), so transcripts essentially always render with descriptions. Messages whose content contains a link are re-fetched after ~1s (Discord unfurls link embeds asynchronously, and the create payload carries none of them), overwritten with the embed data and re-`message:ingested` so the describe stage picks up the embed media.

## Filemap

### `main.js` - entry point

Entrypoint; bootstraps and wires everything together.

- Checks `DISCORD_TOKEN`/`GUILD_ID`/`OPENROUTER_API_KEY` and the describe prompt file, runs `initDb()`, logs in the discord.js client
- On `ClientReady`: fetches the guild, creates the event bus, attaches live ingestion and the media describe stage, then awaits `syncMessages` -> `syncChunks` -> `syncEmbeds`, attaching the chunk/embed/rag live handlers between them. Live traffic keeps flowing through the same chain afterwards.

### `lib/db.js` - SQLite persistence layer

Module singleton: `initDb(file = 'data/database.db')` opens/creates the DB, creates the parent directory, enables WAL and applies the schema (`users`, `messages`, `chunks`, `media_descriptions`) into a module-private handle - no function takes the handle.

- `upsertUser(user)` - writes a user row from a single discord.js object: a GuildMember (detected via its roles manager) supersedes a bare User, whose fields are still reachable through `member.user`. With member data: full upsert (username, nickname, avatar, role names, join date, presence, `COALESCE`-style preservation of joined_at/status); without: seed-if-absent. Account/message times are not stored - they derive from the snowflake ids.
- `upsertMessage(msg, member = msg.member ?? null)` - inserts or updates a message row and upserts its author. Normalizes: forwarded-message snapshots (content and media come from the snapshot, not the forward shell), system message placeholders (`SYSTEM_PLACEHOLDERS`), attachments/embeds/stickers into a `media` JSON array, reaction counts, mention role/channel names (a `mentions` JSON object; mentioned users are also seeded into `users` for render-time name lookup), reply/forward references. Embed handling is delegated to `lib/scrape/embeds.js` (see there). Media entries store exactly what render reads back: `{ type, url }` plus `hash`/`description`, which start unset and are landed asynchronously by the describe stage (`hash` records the `media_descriptions` linkage); a re-upsert carries existing hash/description over by url so reaction/edit/embed-refetch refreshes never clobber them. Gif attachments are typed `gif` (also gifv embeds and animated sticker formats) so the describe prompt can flag them as silent.
- `getOldestMessageId(channelId)` / `getNewestMessageId(channelId)` - `MIN(id)`/`MAX(id)` snowflake bounds for a channel; used by the sync passes.
- `getChannelStats()` - per-channel `Map` of `{ messages, chunks, embedded }` (one `GROUP BY` each over messages and chunks); pulled by the status table renderer.
- `getMessages(channelId, { before, after, limit, fields })` - the single message reader. `before`/`after` are exclusive snowflake cursors (Discord fetch semantics), rows always come back ascending, `limit` keeps the rows nearest the bounded side (the embed overlaps), `fields` picks columns (the chunk stage only needs ids, which skips the users join). The joined `author` label is `COALESCE(nickname, username, author_id)`.
- `getMessage(messageId)` - single row with the author-label join; used for reply rendering and window endpoints. `getUsers(ids)` - mention-label lookup for rendering, `id -> COALESCE(nickname, username, id)` matching the author labels.
- Media description cache: `getMediaDescription(hash)` / `upsertMediaDescription(hash, type, description)` against the `media_descriptions` table (content-hash keyed, making identical re-posts free), plus `setMessageMediaDesc(messageId, url, hash, description)` for writing hash and description back into a message's media JSON.
- Chunk table CRUD: `insertChunk`, `extendChunk`, `deleteChunk`, `setChunkOpen`, `setChunkEmbedding`, plus reads `getMessageChannelIds`, `getLastChunk`, `getOpenChunks`, `getUnembeddedClosedChunks`. `chunks.open = 1` marks the channel tail still accepting live appends; `chunks.embedding` holds the dummy embedding artifact path (NULL = not embedded).

### `lib/log.js` - logging

Exports a single `log` singleton, imported directly (never passed through function args). Built at import time; reads `--log-level=` from `process.argv` via `parseArgs` (non-strict; invalid values fall back to `info`):

- `.error/.warn` → stderr, `.info/.debug` → stdout; each line is `<iso-timestamp> <level-padded> <message>`; `format()`-style variadic args. Messages carry their own bracket prefix (e.g. `[scrape] ...`).
- `.progress` - pipeline status table API: `update(id, name, phase, fetches)` / `done(id, name, fetches)` (scrape stage; registers the channel row - threads stay excluded), `refresh()` (re-render from current db state) and `chars(chunkId, channelId, n)` (record a rendered chunk's size). Renders whenever stdout is a TTY, at any log level; without a TTY it degrades to one plain log line per event, active only at debug level. Columns per channel: `phase` (`sync` during both scrape passes, `done` after), `fetches` (api fetch batches, per-run), `messages`/`chunks`/`embedded` (pulled from the db at render time), `chars`/`avg` (total and per-chunk average of characters rendered this run, keyed by chunk id so re-renders overwrite). A `Total` row sums every column (`avg` = total chars / chunks rendered this run). The table stays pinned at the bottom of the output: each stdout log line erases it, prints, and redraws it below itself (stderr lines may still clobber it - known limitation).

All logging goes through this module, not `console.*`.

### `lib/scrape/embeds.js` - embed normalization

`embedMedia(content, embeds)` - the one place that knows what the discord embed payload means, distilled from real gateway payloads:

- `gifv` embeds (tenor, klipy) are bare media presentations: the client never renders their (SEO junk) titles, so they become a single `gif` media entry from the thumbnail (fallback: the video url) with no text entry.
- Other embeds contribute an `image` entry (image, fallback thumbnail) or a `video` entry, plus one `text` entry condensing all text fields as `**Title** description **author** (host)` (missing fields skipped, host parsed off the embed url for provenance). YouTube embeds (youtube.com/youtu.be) drop the description - the client only ever shows title and author there.
- Sole-link hiding: when the message content is nothing but http(s) urls and the embeds yielded at least one entry, the content is blanked - the client replaces such a message with its embeds, and the raw url is noise to the embedding model. A link that never unfurled (no embeds) stays visible as the only trace the message existed.

Returns `{ content, media }` - exactly what db.js stores; render.js never needs to know any of this.

### `lib/scrape/live.js` - live traffic ingestion

- `attachMessages(client, bus)` - `MessageCreate`/`MessageUpdate`/reaction handlers upsert into the DB; after each new message upsert the raw `message:ingested` event is emitted on the bus for the downstream chunk stage. Update/reaction handlers only refresh the stored rows. `MessageCreate` content containing a link is re-fetched after ~1s and re-upserted with the unfurled embeds (re-emitting `message:ingested` so the describe stage queues the embed media) - the create payload itself carries no embeds.

### `lib/scrape/backfill.js` - history scraping

- `syncMessages(guild)` - collects all scrapable channels, then scrapes them all concurrently. Per channel (non-threads register a status-table row up front with `phase=sync, fetches=0`, so channels with no new traffic still appear):
  - `catchUp` pass - paginate forward from the newest stored id (skips entirely on a fresh channel)
  - `backfill` pass - paginate backward from the oldest stored id to the very beginning. Both passes report as `sync` with the running fetch total; `done` follows.

### `lib/ai/` - media description stage

`attachDescribe(bus)` + `describeMedia(url, type)`. Describes media with free OpenRouter models on live ingests only - backfill never emits `message:ingested`, so archived history is deliberately left undescribed.

- `lib/ai/client.js` - `getOpenRouter()` module-singleton SDK client, and `getFreeModels(modality)`: discovers free models (zero prompt/completion pricing) that accept the given input modality by listing the model catalog, cached per process.
- `lib/ai/describe.js` - `describeMedia(url, type)` downloads the bytes, sha256-hashes them and checks the `media_descriptions` cache; on a miss it sends the media to the next free model for the modality (image/gif share the image modality, with `image_url` data URLs; audio uses `input_audio` base64) using the prompt template. Outcomes: `{ description, hash }` (stored by hash, written into the message's media JSON), `'Failed to download'` (download errors or oversized media, > 20 MB - no hash), or a retryable describe failure - those leave `description` null, trigger an exponential backoff (doubling from 1 min to 15 min, reset on success) and requeue for a later attempt with the next rotated free model. Unsupported downloads (lottie stickers are `application/json`) are warned and skipped.
- `attachDescribe` feeds each non-text, undescribed media entry of a live message into a serial queue (one request at a time - free-tier rate limits are tight), skipping entries already queued for that message so the embed-refetch re-ingest never double-downloads.

### `prompts/describe-media.txt` - describe prompt template

Plain text, re-read per describe call so tweaks apply without a restart. Supports one inject: `{type}` (one of `image`, `video`, `audio`, `gif`). Missing file is a hard startup error.

### `lib/embed/chunk.js` - chunk stage

`syncChunks()` + `attachChunk(bus)`. Time-based chunking: a >`GAP_MS` (5 min) gap between messages ends a chunk; ranges of more than `MAX_MESSAGES` (50) messages are subsplit at their longest internal time gap (ties broken toward the midpoint), recursively.

- `syncChunks` draws chunk boundaries on each channel's ordered id list alone - times derive from the snowflakes, so no content is ever read. The channel tail is left `open` only when its last message is still inside the gap window. Channels that already have rows (restart) replay everything newer than the last chunk through the live merge path, covering downtime catch-up. The status table is refreshed after each channel's pass.
- `attachChunk` on `message:ingested`: appends to the open tail when inside the gap window, otherwise closes the tail and opens a fresh chunk. A straggler landing inside the window of a settled tail reopens it and clears its embedding; a re-ingested message older than the tail's newest (the ~1s embed refetch can land after newer traffic) never extends `last_message_id` backwards. Emits `message:chunked` after a status-table refresh (which also picks up the live message count).

### `lib/render.js` - transcript rendering

- `renderChunk(channel, beforeId, afterId)` - renders the inclusive message window (`null` = channel start/end) as a transcript. `channel` is a `{ id, name }` object (any discord.js channel works). Consecutive messages from the same author collapse into one block; replies prefix `[Reply to @nickname]` (bare `[Reply]` when the referenced message isn't archived), forwards prefix `[Forwarded]`, media render as `[Image]`/`[Video]`/`[Audio]`/`[Gif]`/`[Text]` markers carrying their description when one has landed (`[Image: a cat wearing a hat]`), reactions render as counts. Mention markup resolves to display names the way a client user sees them: `<@id>`/`<@!id>` -> `@nickname` via the users table, `<@&id>` -> `@role` and `<#id>` -> `#channel` via the ingest-time mention maps, `@unknown-user`-style placeholders when a lookup misses. That is all the cleaning there is: sole-link content was already blanked at ingest, so suppressed messages just render their media markers. The same cleaning applies to reply-quote previews, which fall back to the target's media markers when its content is blank:

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
- Ready chunks are rendered as their core window widened by up to `OVERLAP_MESSAGES` on each side - one transcript via `renderChunk` - written to `data/embeddings/<channel-name>-<channel-id>/<first-message-id>.txt`, and their `chunks.embedding` is set to the file path; the rendered size is recorded into the status table via `log.progress.chars`. The open tail stays NULL - it is never embedded while it can still grow.
- Emits `message:embedded` per message.

### `lib/rag.js` - rag stage (placeholder)

- `attachRag(client, bus)` - attached after the embed stage. On each `message:embedded` (non-bot author): `@`-mention or `Math.random() < RAG_RANDOM_CHANCE` triggers a log line saying it would respond. No LLM call yet.

## Conventions

- ESM (`"type": "module"`), Node >= 18 (uses `util.parseArgs`).
- Style enforced by `npm run lint` (see `eslint.config.js`): 2-space indent, no semicolons, single quotes, space before function parens (`function name ()`), operators at line ends.
- No single-use private helper functions: logic that runs once is inlined at its call site (this was deliberately cleaned up in `lib/db.js` and the scrape modules - don't reintroduce helpers).
- The db handle is a module singleton (`initDb`), imported directly like `log` - never passed through function args.
- DB writes are upserts; the scrape is restartable and idempotent. Snowflake ids double as sort keys (monotonic), which is why `MIN(id)`/`MAX(id)` give channel bounds.
