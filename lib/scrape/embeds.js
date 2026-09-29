// Embed normalization, distilled from real gateway payloads (the api's embed
// types are rich, image, video, gifv, article, link, poll_result):
// - image and gifv embeds are bare media presentations; gifv titles (SEO
//   junk on tenor and friends) are never rendered by the client
// - video embeds without text fields are bare media too, while youtube (and
//   article/link/rich page previews) carry readable text
// What comes out is exactly what the db stores per entry: { type, url } for
// media (hash/description land later via the describe stage), and just
// { type, description } for text - render never needs more.

export function embedMedia (content, embeds) {
  const media = []
  for (const e of embeds ?? []) {
    if (e.type === 'gifv') {
      const url = e.thumbnail?.url ?? e.video?.url
      if (url) media.push({ type: 'gif', url })
      continue
    }
    const imageUrl = e.image?.url ?? e.thumbnail?.url
    if (imageUrl) media.push({ type: 'image', url: imageUrl })
    else if (e.video?.url) media.push({ type: 'video', url: e.video.url })
    // youtube embeds never render their (huge) description client-side,
    // users only see title and author
    const youtube = /youtu\.be\/|youtube\.com\//.test(
      [e.url, e.author?.url, e.video?.url].filter(Boolean).join(' ')
    )
    // the host keeps a trace of where the linked content came from
    const host = e.url?.match(/^https?:\/\/([^/?#]+)/)?.[1]
    const text = [
      e.title && `**${e.title}**`,
      youtube ? null : e.description,
      e.author?.name && `**${e.author.name}**`,
      host && `(${host})`
    ].filter(Boolean).join(' ')
    if (text) media.push({ type: 'text', description: text })
  }
  // a message that is nothing but urls is replaced by its embeds in the
  // client, and the raw url is pure noise to the embedding model - blank it.
  // Gated on the embeds yielding at least one entry: a link that never
  // unfurled stays visible as the only trace the message ever existed.
  const hidden = media.length > 0 &&
    content != null &&
    content.trim().split(/\s+/).every((token) => /^https?:\/\//.test(token))
  return { content: hidden ? null : content, media }
}
