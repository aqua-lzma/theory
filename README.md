# Theory

Discord guild archiver: scrapes full message history plus live traffic into SQLite.

## Running

```sh
npm start
```

Environment (loaded via dotenv):

- `DISCORD_TOKEN` - bot token (required)
- `GUILD_ID` - guild to archive (required)

CLI arg:

- `--log-level=<error|warn|info|debug>` - default `info`. `debug` also enables the scrape progress table.

Data lives in `data/database.db` (SQLite, WAL mode).

## Filemap

### `main.js` - entry point

Entrypoint; bootstraps and wires everything together.

- Checks `DISCORD_TOKEN`/`GUILD_ID`, opens the DB, logs in the discord.js client
- On `ClientReady`: `attachLiveHandlers()`, then `runBackfill()`. Live handlers keep running afterwards.

### `lib/db.js` - SQLite persistence layer

Exports (all take the `better-sqlite3` handle as first arg):

- `openDb(file = 'data/database.db')` - opens/creates the DB, creates the parent directory, enables WAL, applies the schema.
- `upsertUser(db, author, member)` - writes a user row. With member data: full upsert (username, nickname, avatar, role names, account/join dates, presence, `COALESCE`-style preservation of joined_at/status).
- `upsertMessage(db, msg, member = msg.member ?? null)` - inserts or updates a message row and upserts its author. Normalizes: forwarded-message snapshots (content and media come from the snapshot, not the forward shell), system message placeholders (`SYSTEM_PLACEHOLDERS`), attachments/embeds/stickers into a `media` JSON array, reaction counts, mention ids, reply/forward references.
- `getOldestMessageId(db, channelId)` / `getNewestMessageId(db, channelId)` - `MIN(id)`/`MAX(id)` snowflake bounds for a channel; used by the backfill passes.
- `getChannelMessageCount(db, channelId)` - message count; used for progress display.

### `lib/log.js` - logging

Exports a single `log` singleton, imported directly (never passed through function args). Built at import time; reads `--log-level=` from `process.argv` via `parseArgs` (non-strict; invalid values fall back to `info`):

- `.error/.warn` → stderr, `.info/.debug` → stdout; each line is `<iso-timestamp> <level-padded> <message>`; `format()`-style variadic args. Messages carry their own bracket prefix (e.g. `[scrape] ...`).
- `.progress` - scrape progress API with `update(id, name, phase, batches, messages)` and `done(...)`. Active only at debug level: ANSI re-rendered table when stdout is a TTY, one plain log line per event when not, no-op otherwise.

All logging goes through this module, not `console.*`.

### `lib/scrape/backfill.js` - history scraping

- `runBackfill(guild, db)` - collects all scrapable channels, then scrapes them all concurrently. Per channel:
  - `catchUp` pass - paginate forward from the newest stored id (skips entirely on a fresh channel)
  - `backfill` pass - paginate backward from the oldest stored id to the very beginning.

## Conventions

- ESM (`"type": "module"`), Node >= 18 (uses `util.parseArgs`).
- Style enforced by `npm run lint` (see `eslint.config.js`): 2-space indent, no semicolons, single quotes, space before function parens (`function name ()`), operators at line ends.
- No single-use private helper functions: logic that runs once is inlined at its call site (this was deliberately cleaned up in `lib/db.js` and the scrape modules - don't reintroduce helpers).
- DB writes are upserts; the backfill is restartable and idempotent. Snowflake ids double as sort keys (monotonic), which is why `MIN(id)`/`MAX(id)` give channel bounds.
