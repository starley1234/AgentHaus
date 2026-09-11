import { describe, expect, it } from "vitest";
import type { OpenRouterModelInfo } from "#/api/config-service/config-service.types";
import {
  applyFloorSuffix,
  buildOpenRouterExtraModels,
  formatContextLength,
  formatPricePair,
  formatPricePerMillion,
  hasFloorSuffix,
  stripFloorSuffix,
} from "#/utils/openrouter-model-utils";

describe("openrouter-model-utils", () => {
  it("appends and strips the :floor suffix", () => {
    expect(hasFloorSuffix("google/gemini-3.8-flash")).toBe(false);
    expect(hasFloorSuffix("google/gemini-3.8-flash:floor")).toBe(true);

    expect(applyFloorSuffix("google/gemini-3.8-flash", true)).toBe(
      "google/gemini-3.8-flash:floor",
    );
    expect(applyFloorSuffix("google/gemini-3.8-flash", false)).toBe(
      "google/gemini-3.8-flash",
    );
    // Toggling off an already-suffixed model keeps the base id.
    expect(applyFloorSuffix("google/gemini-3.8-flash:floor", false)).toBe(
      "google/gemini-3.8-flash",
    );
    // Toggling on twice does not double-append.
    expect(applyFloorSuffix("google/gemini-3.8-flash:floor", true)).toBe(
      "google/gemini-3.8-flash:floor",
    );

    expect(stripFloorSuffix("google/gemini-3.8-flash:floor")).toBe(
      "google/gemini-3.8-flash",
    );
    expect(stripFloorSuffix("google/gemini-3.8-flash")).toBe(
      "google/gemini-3.8-flash",
    );
  });

  it("formats context lengths and prices for the model subtitle", () => {
    expect(formatContextLength(1_000_000)).toBe("1M");
    expect(formatContextLength(2_500_000)).toBe("2.5M");
    expect(formatContextLength(256_000)).toBe("256K");
    expect(formatContextLength(8192)).toBe("8.2K");

    expect(formatPricePerMillion(0.000_001_25)).toBe("$1.25");
    expect(formatPricePerMillion(0.000_004)).toBe("$4.00");
    expect(formatPricePerMillion(null)).toBe("");

    expect(formatPricePair(0.000_001_25, 0.000_01)).toBe("$1.25/$10.00");
    expect(formatPricePair(null, null)).toBe("");
  });

  it("adds only live-catalog models missing from the litellm list", () => {
    const catalog: OpenRouterModelInfo[] = [
      {
        id: "google/gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        context_length: 1_000_000,
        prompt_price_per_token: 0.000_001,
        completion_price_per_token: 0.000_004,
      },
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        context_length: 200_000,
        prompt_price_per_token: 0.000_003,
        completion_price_per_token: 0.000_015,
      },
    ];

    const extra = buildOpenRouterExtraModels(
      catalog,
      new Set(["anthropic/claude-sonnet-4.5"]),
    );

    expect(extra).toEqual([
      {
        provider: "openrouter",
        name: "google/gemini-3.8-flash",
        verified: false,
      },
    ]);
    expect(buildOpenRouterExtraModels(undefined, new Set())).toEqual([]);
  });
});
