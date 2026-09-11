import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import ConfigService from "#/api/config-service/config-service.api";
import { server } from "#/mocks/node";

describe("ConfigService", () => {
  it("derives providers from llm endpoints", async () => {
    const page = await ConfigService.searchProviders({ limit: 10 });

    expect(page.next_page_id).toBeNull();
    expect(page.items.some((provider) => provider.name === "anthropic")).toBe(true);
    expect(
      page.items.find((provider) => provider.name === "anthropic")?.verified,
    ).toBe(true);
  });

  it("derives provider models from llm endpoints", async () => {
    const page = await ConfigService.searchModels({
      provider__eq: "anthropic",
      limit: 20,
    });

    expect(page.next_page_id).toBeNull();
    expect(page.items.some((model) => model.name === "claude-opus-4-5-20251101")).toBe(
      true,
    );
    expect(page.items.every((model) => model.provider === "anthropic")).toBe(true);
  });



  it("fetches the OpenRouter catalog from the local agent-server", async () => {
    server.use(
      http.get("/api/llm/openrouter/models", () =>
        HttpResponse.json({
          source: "live",
          fetched_at: 1757500000,
          models: [
            {
              id: "google/gemini-3.8-flash",
              name: "Gemini 3.8 Flash",
              context_length: 1000000,
              prompt_price_per_token: "0.000001",
              completion_price_per_token: "0.000004",
            },
          ],
        }),
      ),
    );

    const catalog = await ConfigService.getOpenRouterCatalog();

    expect(catalog.source).toBe("live");
    expect(catalog.models[0].id).toBe("google/gemini-3.8-flash");
    expect(catalog.models[0].context_length).toBe(1000000);
  });

  it("throws on a non-ok OpenRouter catalog response", async () => {
    server.use(
      http.get("/api/llm/openrouter/models", () =>
        HttpResponse.json({ detail: "boom" }, { status: 503 }),
      ),
    );

    await expect(ConfigService.getOpenRouterCatalog()).rejects.toThrow(
      /503/,
    );
  });

  it("filters models server-side when provider__eq is set (no full-catalog fetch)", async () => {
    // The local agent-server supports ?provider= on /api/llm/models; the
    // client must use it instead of pulling the entire litellm catalog
    // (~5.5k models, >100 KB) on every provider selection.
    let requestedUrl = "";
    server.use(
      http.get("/api/llm/models", ({ request }) => {
        requestedUrl = new URL(request.url).searchParams.toString();
        return HttpResponse.json({
          models: [
            "anthropic/claude-opus-4-5-20251101",
            "anthropic/claude-sonnet-4-5",
          ],
        });
      }),
    );

    const page = await ConfigService.searchModels({
      provider__eq: "anthropic",
      limit: 20,
    });

    expect(requestedUrl).toContain("provider=anthropic");
    expect(page.items.some((model) => model.name === "claude-sonnet-4-5")).toBe(
      true,
    );
    expect(page.items.every((model) => model.provider === "anthropic")).toBe(
      true,
    );
  });

  it("includes verified providers absent from /api/llm/providers and keeps them within the limit", async () => {
    // Arrange: mirror the real local agent-server, where
    // /api/llm/providers comes from litellm (no "openhands"),
    // but /api/llm/models/verified has "openhands" as a key.
    const litellmOnlyProviders = Array.from(
      { length: 10 },
      (_, i) => `litellm_provider_${i}`,
    );
    server.use(
      http.get("/api/llm/providers", () =>
        HttpResponse.json({ providers: litellmOnlyProviders }),
      ),
      http.get("/api/llm/models/verified", () =>
        HttpResponse.json({
          models: {
            openhands: ["claude-opus-4-7", "gpt-5.5"],
            anthropic: ["claude-opus-4-5-20251101"],
          },
        }),
      ),
    );

    // Act: request fewer items than the litellm provider count to also
    // exercise the ordering fix (verified providers must come first so
    // they survive limitItems).
    const page = await ConfigService.searchProviders({ limit: 3 });

    // Assert
    const openhands = page.items.find((p) => p.name === "openhands");
    expect(openhands).toEqual({ name: "openhands", verified: true });
  });
});
