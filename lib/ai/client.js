import { OpenRouter } from '@openrouter/sdk'

// module singleton like the db handle, created on first use. The SDK default
// retries connection errors and 5XX for up to an hour with no request timeout;
// bounded here so persistent outages surface quickly and fall through to the
// describe stage's own backoff instead of pinning its serial queue.
let client = null

export function getOpenRouter () {
  if (!client) {
    client = new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      timeoutMs: 120_000,
      retryConfig: {
        strategy: 'backoff',
        backoff: { initialInterval: 500, maxInterval: 10_000, exponent: 1.5, maxElapsedTime: 30_000 },
        retryConnectionErrors: true
      }
    })
  }
  return client
}

// Free models that accept the given input modality ('image' also covers gifs).
// Discovered once per process and cached as a promise so concurrent callers
// share a single catalog fetch. Sorted for deterministic picking; an empty
// result is not cached so a later attempt re-discovers.
const freeModels = new Map()

async function discover (modality) {
  const models = []
  for await (const page of await getOpenRouter().models.list()) {
    for (const m of page.result.data) {
      if (m.pricing.prompt === '0' &&
        m.pricing.completion === '0' &&
        m.architecture.inputModalities.includes(modality) &&
        m.architecture.outputModalities.includes('text')) {
        models.push(m.id)
      }
    }
  }
  models.sort()
  if (!models.length) freeModels.delete(modality)
  return models
}

export function getFreeModels (modality) {
  if (!freeModels.has(modality)) freeModels.set(modality, discover(modality))
  return freeModels.get(modality)
}
