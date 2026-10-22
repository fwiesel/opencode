import { define } from "@opencode/plugin/effect/plugin"
import type { Document, Entry } from "@opencode/schema/config"
import { Effect, Semaphore, Stream } from "effect"
import { HttpClient } from "effect/http"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Credential } from "../../credential.js"
import { Provider } from "../../provider.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { ProviderModels } from "./models.js"
import type { PluginInternal } from "../internal.js"
import { foldSettings } from "./configured.js"

// These providers have dedicated discovery plugins that own their whole model list.
const dedicated = new Set(["ollama", "lmstudio", "vllm"])

export function make() {
  return define({
    id: "opencode.provider.openai-compatible",
    effect: Effect.fn(function* (ctx) {
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const providers = yield* Provider.Service
      const loading = Semaphore.makeUnsafe(1)
      const loaded = {
        inventory: new Map<
          Provider.ID,
          {
            source: string
            ids: readonly string[]
            connection?: Effect.Success<ReturnType<typeof ctx.integration.connection.active>>
          }
        >(),
        hash: "[]",
      }

      // Configuration has already captured alias metadata. Its late model edits retain final precedence.
      yield* ctx.provider.transform((providers) => {
        for (const [providerID, item] of loaded.inventory) {
          const current = providers.get(providerID)
          if (!current) continue
          providers.add({
            info: current.provider,
            models: Array.from(current.models.values()).filter((model) => item.ids.includes(model.modelID ?? model.id)),
            sourceConnection: item.connection,
          })
          // Retain #57161's additive discovery for generic gateways; native adapters use catalog metadata only.
          if (current.provider.package === "@opencode/ai/providers/openai-compatible")
            for (const id of item.ids) providers.models.update(providerID, id, () => {})
        }
      })

      const inventory = Effect.fnUntraced(function* (providerID: Provider.ID) {
        const current = yield* providers.get(providerID)
        if (!current) return []
        // Config observers run independently; discovery must not read the previous endpoint during a reload.
        const entries = yield* config.entries()
        const configured = entries
          .filter((entry): entry is Document => entry.type === "document")
          .flatMap((entry) => entry.info.providers?.[providerID] ?? [])
        const provider = {
          ...current,
          settings: foldSettings(entries, providerID, current.settings),
          headers: configured.reduce((headers, item) => Provider.mergeHeaders(headers, item.headers), current.headers),
        }
        const format = ProviderModels.protocol(provider.package)
        const baseURL = provider.settings?.baseURL
        if (!format || typeof baseURL !== "string" || !URL.canParse(baseURL)) return []
        if (!["http:", "https:"].includes(new URL(baseURL).protocol)) return []
        const integrationID = provider.integrationID ?? providerID
        const connection = yield* ctx.integration.connection.active(integrationID)
        const credential = connection
          ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        // Same precedence as requests: a stored key replaces the configured one.
        const source = JSON.stringify([
          provider.package,
          provider.settings,
          provider.headers,
          credential,
          IntegrationConnection.key(connection),
        ])
        const previous = loaded.inventory.get(providerID)
        const ids = yield* ProviderModels.fetch(provider, format, baseURL, credential).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.timeout("5 seconds"),
          Effect.map((ids) => [...ids].toSorted()),
          // Do not log the HTTP cause: it can contain credentials and configured headers.
          Effect.tapError(() =>
            Effect.logWarning("Endpoint model discovery failed; retaining fallback", { providerID }),
          ),
          // Keep the last successful inventory through transient outages while the endpoint and key are unchanged.
          Effect.orElseSucceed(() => (previous?.source === source ? previous.ids : undefined)),
        )
        if (
          IntegrationConnection.key(connection) !==
          IntegrationConnection.key(yield* ctx.integration.connection.active(integrationID))
        )
          return []
        return ids === undefined ? [] : [[providerID, { source, ids, connection }] as const]
      })

      const load = Effect.fn("OpenAICompatiblePlugin.load")(function* () {
        const results = yield* Effect.forEach(targets(yield* config.entries()), inventory, { concurrency: 4 })
        const next = new Map(results.flat())
        const hash = JSON.stringify([...next])
        if (hash === loaded.hash) return
        loaded.inventory = next
        loaded.hash = hash
        yield* ctx.provider.reload()
      })
      const refresh = () => loading.withPermit(load())

      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(refresh),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* bus
        .subscribe([Credential.Event.Updated, Credential.Event.Switched])
        .pipe(Stream.runForEach(refresh), Effect.forkScoped({ startImmediately: true }))
      yield* refresh()
    }),
  } satisfies PluginInternal.InternalPlugin)
}

export const OpenAICompatiblePlugin = make()

function targets(entries: readonly Entry[]) {
  const documents = entries.filter((entry): entry is Document => entry.type === "document")
  const ids = new Set(documents.flatMap((file) => Object.keys(file.info.providers ?? {})))
  return [...ids].flatMap((id) => {
    if (dedicated.has(id)) return []
    const settings = foldSettings(entries, id, undefined)
    const baseURL = typeof settings?.baseURL === "string" ? settings.baseURL.replace(/\/+$/, "") : ""
    if (!URL.canParse(baseURL) || !["http:", "https:"].includes(new URL(baseURL).protocol)) return []
    return [Provider.ID.make(id)]
  })
}
