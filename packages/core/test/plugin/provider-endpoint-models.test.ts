import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { OpenAICompatiblePlugin } from "@opencode/core/plugin/provider/openai-compatible"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Document, Event, Info } from "@opencode/schema/config"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)
const document = (providers: Info["providers"]) => [new Document({ type: "document", info: decode({ providers }) })]
const server = (fetch: (request: Request) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => Effect.promise(() => server.stop(true)),
  )
const setup = Effect.fn(function* (entries: Document[]) {
  const providers = yield* Provider.Service
  const models = yield* Model.Service
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  const config = yield* Config.Test
  yield* config.setEntries(entries)
  yield* providers.transform((editor) => {
    for (const id of ["anthropic", "google", "openai"]) {
      editor.update(Provider.ID.make(id), (provider) => {
        provider.activation = "enabled"
        provider.package = `@opencode/ai/providers/${id}`
      })
      for (const name of ["served", "second", "ghost"])
        editor.models.update(Provider.ID.make(id), Model.ID.make(name), (model) => {
          model.limit.context = 123456
        })
      editor.models.update(Provider.ID.make(id), Model.ID.make("served"), (model) => {
        model.settings = { baseURL: "https://original.invalid/v1" }
      })
    }
  })
  yield* ConfigProviderPlugin.Plugin.effect(host)
  yield* OpenAICompatiblePlugin.effect(host)
  return models
})
const updated = Effect.fn(function* (models: Model.Interface, id: string) {
  const bus = yield* Bus.Service
  return yield* bus.subscribe(Provider.Event.Updated).pipe(
    Stream.filterEffect(() =>
      models.get(Provider.ID.openai, Model.ID.make(id)).pipe(Effect.map((model) => model !== undefined)),
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkChild({ startImmediately: true }),
  )
})

describe("configured endpoint discovery", () => {
  it.live("selects native discovery by adapter rather than provider name", () =>
    Effect.gen(function* () {
      const endpoint = yield* server((request) => {
        expect(request.headers.get("x-goog-api-key")).toBe("key")
        return Response.json({ models: [{ name: "models/served" }] })
      })
      const models = yield* setup(
        document({
          "company-gateway": {
            canonical: Provider.ID.make("google"),
            settings: { baseURL: `${endpoint.url.origin}/v1`, apiKey: "key" },
            models: { served: { modelID: Model.ID.make("served") }, ghost: { disabled: true } },
          },
        }),
      )
      expect(yield* models.get(Provider.ID.make("company-gateway"), Model.ID.make("served"))).toMatchObject({
        limit: { context: 123456 },
        package: "@opencode/ai/providers/google",
      })
    }),
  )

  it.effect("bounds discovery and leaves dedicated and unconfigured providers alone", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const loading = yield* setup(
        document({
          openai: { settings: { baseURL: "https://unresponsive.invalid/v1" } },
          lmstudio: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: "http://localhost:1234/v1" },
            models: { local: {} },
          },
        }),
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://unresponsive.invalid/v1/models")
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(started)
      yield* TestClock.adjust("5 seconds")
      const models = yield* Fiber.join(loading)
      expect(yield* models.get(Provider.ID.openai, Model.ID.make("ghost"))).toBeDefined()
      expect(yield* models.get(Provider.ID.make("lmstudio"), Model.ID.make("local"))).toBeDefined()
    }),
  )

  it.live("uses the selected Anthropic OAuth token and preserves explicit model endpoints", () =>
    Effect.gen(function* () {
      const endpoint = yield* server((request) => {
        expect(request.headers.get("authorization")).toBe("Bearer oauth-token")
        expect(request.headers.get("x-api-key")).toBeNull()
        return Response.json({ data: [{ id: "served" }] })
      })
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("anthropic"),
        value: Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("oauth"),
          access: "oauth-token",
          refresh: "refresh",
          expires: 0,
        }),
      })
      const models = yield* setup(
        document({
          anthropic: {
            settings: { baseURL: `${endpoint.url.origin}/v1`, apiKey: "ignored-config-key" },
            models: { served: { settings: { baseURL: "https://explicit.invalid/v1" } } },
          },
        }),
      )
      expect(yield* models.get(Provider.ID.make("anthropic"), Model.ID.make("served"))).toMatchObject({
        settings: { baseURL: "https://explicit.invalid/v1" },
      })
    }),
  )

  it.live("discovers a custom adapter and preserves aliases to catalog models omitted by the endpoint", () =>
    Effect.gen(function* () {
      const endpoint = yield* server((request) => {
        expect(request.headers.get("authorization")).toBe("Bearer header-key")
        return Response.json({ data: [{ id: "new-model" }] })
      })
      const models = yield* setup(
        document({
          gateway: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${endpoint.url.origin}/v1`, apiKey: "settings-key" },
            headers: { authorization: "Bearer header-key" },
          },
          openai: {
            settings: { baseURL: `${endpoint.url.origin}/v1` },
            headers: { authorization: "Bearer header-key" },
            models: { alias: { modelID: Model.ID.make("ghost") } },
          },
        }),
      )
      expect(yield* models.get(Provider.ID.make("gateway"), Model.ID.make("new-model"))).toMatchObject({
        modelID: "new-model",
        package: "@opencode/ai/providers/openai-compatible",
      })
      expect(yield* models.get(Provider.ID.openai, Model.ID.make("alias"))).toMatchObject({
        modelID: "ghost",
        limit: { context: 123456 },
      })
    }),
  )

  it.live("uses native auth and every page, retaining metadata and explicit overrides", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const endpoint = yield* server((request) => {
        const url = new URL(request.url)
        const id = url.pathname.split("/")[1]
        requests.push(url.pathname + url.search)
        expect(
          request.headers.get(id === "anthropic" ? "x-api-key" : id === "google" ? "x-goog-api-key" : "Authorization"),
        ).toBe(id === "openai" ? "Bearer key" : "key")
        if (id === "google")
          return Response.json(
            url.search
              ? { models: [{ name: "models/second" }, { name: "models/endpoint-only" }] }
              : { models: [{ name: "models/served" }], nextPageToken: "next" },
          )
        if (id === "anthropic") {
          expect(request.headers.get("anthropic-version")).toBe("2023-06-01")
          return Response.json(
            url.search
              ? { data: [{ id: "second" }, { id: "endpoint-only" }] }
              : { data: [{ id: "served" }], has_more: true, last_id: "served" },
          )
        }
        return Response.json({ data: [{ id: "served" }, { id: "endpoint-only" }] })
      })
      const models = yield* setup(
        document(
          Object.fromEntries(
            ["anthropic", "google", "openai"].map((id) => [
              id,
              {
                settings: { baseURL: `${endpoint.url.origin}/${id}/v1/`, apiKey: "key" },
                models: { manual: {}, alias: { modelID: Model.ID.make("served") } },
              },
            ]),
          ),
        ),
      )
      expect(requests).toHaveLength(5)
      for (const id of ["anthropic", "google", "openai"]) {
        expect(yield* models.get(Provider.ID.make(id), Model.ID.make("endpoint-only"))).toBeUndefined()
        expect(yield* models.get(Provider.ID.make(id), Model.ID.make("ghost"))).toBeUndefined()
        expect(yield* models.get(Provider.ID.make(id), Model.ID.make("served"))).toMatchObject({
          limit: { context: 123456 },
          settings: { baseURL: `${endpoint.url.origin}/${id}/v1/` },
        })
        expect(yield* models.get(Provider.ID.make(id), Model.ID.make("manual"))).toBeDefined()
        expect(yield* models.get(Provider.ID.make(id), Model.ID.make("alias"))).toMatchObject({
          modelID: "served",
          limit: { context: 123456 },
        })
      }
      expect(yield* models.get(Provider.ID.make("google"), Model.ID.make("second"))).toBeDefined()
      expect(yield* models.get(Provider.ID.make("anthropic"), Model.ID.make("second"))).toBeDefined()
    }),
  )

  it.live("retains fallback on failed or partial discovery, but accepts an empty inventory", () =>
    Effect.gen(function* () {
      const endpoint = yield* server((request) => {
        const url = new URL(request.url)
        if (url.pathname.startsWith("/anthropic"))
          return url.search
            ? new Response("unavailable", { status: 503 })
            : Response.json({ data: [{ id: "served" }], has_more: true, last_id: "served" })
        return Response.json(url.pathname.startsWith("/google") ? { error: "not an inventory" } : { data: [] })
      })
      const models = yield* setup(
        document(
          Object.fromEntries(
            ["anthropic", "google", "openai"].map((id) => [
              id,
              { settings: { baseURL: `${endpoint.url.origin}/${id}/v1` } },
            ]),
          ),
        ),
      )
      expect(yield* models.get(Provider.ID.make("anthropic"), Model.ID.make("ghost"))).toBeDefined()
      expect(yield* models.get(Provider.ID.make("google"), Model.ID.make("ghost"))).toBeDefined()
      expect(yield* models.get(Provider.ID.openai, Model.ID.make("ghost"))).toBeUndefined()
    }),
  )

  it.live("refreshes on config changes and keeps the last inventory only for the same endpoint", () =>
    Effect.gen(function* () {
      const inventory = { fail: false, id: "served" }
      const endpoint = yield* server(() =>
        inventory.fail ? new Response("unavailable", { status: 503 }) : Response.json({ data: [{ id: inventory.id }] }),
      )
      yield* Effect.gen(function* () {
        const config = yield* Config.Test
        const bus = yield* Bus.Service
        const entries = document({ openai: { settings: { baseURL: `${endpoint.url.origin}/v1` } } })
        yield* config.setEntries(entries)
        const models = yield* setup(entries)
        inventory.id = "second"
        const changed = yield* updated(models, "second")
        yield* bus.publish(Event.Updated, {})
        yield* Fiber.join(changed)
        expect(yield* models.get(Provider.ID.openai, Model.ID.make("served"))).toBeUndefined()
        inventory.fail = true
        const retained = yield* updated(models, "second")
        yield* bus.publish(Event.Updated, {})
        yield* Fiber.join(retained)
        expect(yield* models.get(Provider.ID.openai, Model.ID.make("ghost"))).toBeUndefined()
        yield* config.setEntries(document({ openai: { settings: { baseURL: `${endpoint.url.origin}/other/v1` } } }))
        const reset = yield* updated(models, "ghost")
        yield* bus.publish(Event.Updated, {})
        yield* Fiber.join(reset)
        expect(yield* models.get(Provider.ID.openai, Model.ID.make("ghost"))).toBeDefined()
        yield* config.setEntries(document({ openai: {} }))
        const removed = yield* updated(models, "served")
        yield* bus.publish(Event.Updated, {})
        yield* Fiber.join(removed)
        expect(yield* models.get(Provider.ID.openai, Model.ID.make("served"))).toMatchObject({
          settings: { baseURL: "https://original.invalid/v1" },
        })
      }).pipe(Effect.provide(Config.testLayer()))
    }),
  )

  it.live("uses the selected credential without retaining another account's inventory", () =>
    Effect.gen(function* () {
      const endpoint = yield* server((request) =>
        request.headers.get("Authorization") === "Bearer first"
          ? Response.json({ data: [{ id: "served" }] })
          : new Response("unavailable", { status: 503 }),
      )
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "first" }),
      })
      const models = yield* setup(document({ openai: { settings: { baseURL: `${endpoint.url.origin}/v1` } } }))
      expect(yield* models.get(Provider.ID.openai, Model.ID.make("ghost"))).toBeUndefined()
      const reset = yield* updated(models, "ghost")
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "second" }),
      })
      yield* Fiber.join(reset)
      expect(yield* models.get(Provider.ID.openai, Model.ID.make("ghost"))).toBeDefined()
    }),
  )

  it.live("applies updated provider headers when configuration observers run independently", () =>
    Effect.gen(function* () {
      const endpoint = yield* server((request) =>
        Response.json({ data: [{ id: request.headers.get("x-team") === "second" ? "second" : "served" }] }),
      )
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      const entries = (team: string) =>
        document({
          openai: {
            settings: { baseURL: `${endpoint.url.origin}/v1` },
            headers: { "x-team": team },
          },
        })
      const models = yield* setup(entries("first"))
      yield* config.setEntries(entries("second"))
      const changed = yield* updated(models, "second")
      yield* bus.publish(Event.Updated, {})
      yield* Fiber.join(changed)
      expect(yield* models.get(Provider.ID.openai, Model.ID.make("served"))).toBeUndefined()
    }),
  )
})
