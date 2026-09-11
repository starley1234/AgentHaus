import type {
  LLMModel,
  OpenRouterModelInfo,
} from "#/api/config-service/config-service.types";

/**
 * Helpers for the OpenRouter profile flow:
 * - the provider works natively through litellm (`openrouter/<model id>` hits
 *   https://openrouter.ai/api/v1 with the profile's API key — no base_url),
 * - the live catalog adds context-window/pricing subtitles and fresh models
 *   that are newer than the bundled litellm list,
 * - the `:floor` suffix asks OpenRouter to route to the cheapest provider.
 */

export const OPENROUTER_FLOOR_SUFFIX = ":floor";

export const hasFloorSuffix = (model: string): boolean =>
  model.endsWith(OPENROUTER_FLOOR_SUFFIX);

/** Append or strip the `:floor` suffix on a bare model id. */
export const applyFloorSuffix = (model: string, enabled: boolean): string => {
  const base = hasFloorSuffix(model)
    ? model.slice(0, -OPENROUTER_FLOOR_SUFFIX.length)
    : model;
  return enabled ? `${base}${OPENROUTER_FLOOR_SUFFIX}` : base;
};

/** Strip the `:floor` suffix, keeping the bare OpenRouter model id. */
export const stripFloorSuffix = (model: string): string =>
  hasFloorSuffix(model)
    ? model.slice(0, -OPENROUTER_FLOOR_SUFFIX.length)
    : model;

/** 1000000 → "1M", 256000 → "256K", 8192 → "8192". */
export const formatContextLength = (contextLength: number): string => {
  if (contextLength >= 1_000_000) {
    const millions = contextLength / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (contextLength >= 1_000) {
    const thousands = contextLength / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return String(contextLength);
};

/** 0.00000125 → "$1.25", 0.5 → "$0.50", 0.00000015 → "$0.15". */
export const formatPricePerMillion = (pricePerToken: number | null): string => {
  if (pricePerToken === null || !Number.isFinite(pricePerToken)) {
    return "";
  }
  const perMillion = pricePerToken * 1_000_000;
  return `$${perMillion.toFixed(2)}`;
};

/** "$1.25/$10.00 per 1M" — in/out price pair, or "" when unknown. */
export const formatPricePair = (
  promptPricePerToken: number | null,
  completionPricePerToken: number | null,
): string => {
  const prompt = formatPricePerMillion(promptPricePerToken);
  const completion = formatPricePerMillion(completionPricePerToken);
  if (!prompt && !completion) return "";
  return `${prompt || "?"}/${completion || "?"}`;
};

/**
 * Live-catalog models missing from the litellm-derived list (fresh releases).
 * They render in the "Others" section of the model autocomplete.
 */
export const buildOpenRouterExtraModels = (
  catalogModels: OpenRouterModelInfo[] | undefined,
  knownNames: Set<string>,
): LLMModel[] => {
  if (!catalogModels?.length) return [];
  return catalogModels
    .filter((model) => model.id && !knownNames.has(model.id))
    .map((model) => ({
      provider: "openrouter",
      name: model.id,
      verified: false,
    }));
};
