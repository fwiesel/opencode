export * as ProviderModels from "./models.js"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Credential } from "../../credential.js"
import { Provider } from "../../provider.js"

const Data = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, mode: Schema.optional(Schema.NullOr(Schema.String)) })),
  has_more: Schema.optional(Schema.Boolean),
  last_id: Schema.optional(Schema.String),
})
const Gemini = Schema.Struct({
  models: Schema.Array(Schema.Struct({ name: Schema.String })),
  nextPageToken: Schema.optional(Schema.String),
})

// Select the wire format by adapter, not by the configurable provider name.
export function protocol(pkg: string | undefined) {
  if (pkg === "@opencode/ai/providers/anthropic" || pkg === "@opencode/ai/providers/anthropic-compatible")
    return "anthropic"
  if (pkg === "@opencode/ai/providers/google") return "google"
  if (
    pkg === "@opencode/ai/providers/openai" ||
    pkg === "@opencode/ai/providers/openai/chat" ||
    pkg === "@opencode/ai/providers/openai/responses" ||
    pkg === "@opencode/ai/providers/openai-compatible"
  )
    return "openai"
}

export const fetch = Effect.fn("ProviderModels.fetch")(function* (
  provider: Provider.Info,
  format: NonNullable<ReturnType<typeof protocol>>,
  baseURL: string,
  credential: Credential.Value | undefined,
) {
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const settings = provider.settings
  const key =
    credential?.type === "key" ? credential.key : credential?.type === "oauth" ? credential.access : settings?.apiKey
  const bearer =
    format === "openai" ||
    (format === "anthropic" &&
      (credential?.type === "oauth" || (!credential && typeof settings?.authToken === "string")))
  const token =
    !credential && format === "anthropic" && typeof settings?.authToken === "string" ? settings.authToken : key
  const headers: Record<string, string> = {}
  if (format === "anthropic") headers["anthropic-version"] = "2023-06-01"
  if (typeof token === "string")
    headers[bearer ? "Authorization" : format === "google" ? "x-goog-api-key" : "x-api-key"] = bearer
      ? `Bearer ${token}`
      : token
  const request = HttpClientRequest.get(`${baseURL.replace(/\/+$/, "")}/models`).pipe(
    HttpClientRequest.setHeaders(Provider.mergeHeaders(headers, provider.headers) ?? headers),
  )
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let page: string | undefined
  do {
    const response = yield* http.execute(
      page
        ? request.pipe(HttpClientRequest.setUrlParam(format === "google" ? "pageToken" : "after_id", page))
        : request,
    )
    if (format === "google") {
      const body = yield* HttpClientResponse.schemaBodyJson(Gemini)(response)
      body.models.forEach((model) => ids.add(model.name.replace(/^models\//, "")))
      page = body.nextPageToken
    } else {
      const body = yield* HttpClientResponse.schemaBodyJson(Data)(response)
      body.data
        .filter((model) => model.id.length > 0 && (!model.mode || ["chat", "responses"].includes(model.mode)))
        .forEach((model) => ids.add(model.id))
      page = body.has_more ? (body.last_id ?? body.data.at(-1)?.id) : undefined
      if (body.has_more && !page) return yield* Effect.fail(new Error("Missing model-list cursor"))
    }
    if (page && cursors.has(page)) return yield* Effect.fail(new Error("Repeated model-list cursor"))
    if (page) cursors.add(page)
  } while (page)
  return ids
})
