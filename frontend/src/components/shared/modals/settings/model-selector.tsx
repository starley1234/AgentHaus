import {
  Autocomplete,
  AutocompleteItem,
  AutocompleteSection,
  Checkbox,
} from "@heroui/react";
import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { mapProvider } from "#/utils/map-provider";
import { extractModelAndProvider } from "#/utils/extract-model-and-provider";
import { cn } from "#/utils/utils";
import { formControlSettingsFieldClassName } from "#/utils/form-control-classes";
import { heroUiAutocompleteSelectorButtonClassName } from "#/ui/combobox-caret";
import { HelpLink } from "#/ui/help-link";
import { PRODUCT_URL } from "#/utils/constants";
import { useSearchProviders } from "#/hooks/query/use-search-providers";
import { useProviderModels } from "#/hooks/query/use-provider-models";
import { useOpenRouterCatalog } from "#/hooks/query/use-open-router-models";
import type { OpenRouterModelInfo } from "#/api/config-service/config-service.types";
import {
  applyFloorSuffix,
  buildOpenRouterExtraModels,
  formatContextLength,
  formatPricePair,
  hasFloorSuffix,
  stripFloorSuffix,
} from "#/utils/openrouter-model-utils";

interface ModelSelectorProps {
  isDisabled?: boolean;
  currentModel?: string;
  onChange?: (provider: string | null, model: string | null) => void;
  onDefaultValuesChanged?: (
    provider: string | null,
    model: string | null,
  ) => void;
  wrapperClassName?: string;
  labelClassName?: string;
}

export function ModelSelector({
  isDisabled,
  currentModel,
  onChange,
  onDefaultValuesChanged,
  wrapperClassName,
  labelClassName,
}: ModelSelectorProps) {
  const [, setLitellmId] = React.useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = React.useState<string | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = React.useState<string | null>(null);

  const { data: providers = [] } = useSearchProviders();
  const {
    data: providerModels = [],
    isLoading: isLoadingModels,
    error: modelsError,
  } = useProviderModels(selectedProvider);

  const { t } = useTranslation("openhands");

  const verifiedProviders = React.useMemo(
    () => providers.filter((p) => p.verified),
    [providers],
  );
  const unverifiedProviders = React.useMemo(
    () => providers.filter((p) => !p.verified),
    [providers],
  );

  const verifiedModels = React.useMemo(
    () => providerModels.filter((m) => m.verified),
    [providerModels],
  );
  const unverifiedModels = React.useMemo(
    () => providerModels.filter((m) => !m.verified),
    [providerModels],
  );

  // OpenRouter: live catalog (context window + pricing + fresh models) served
  // by the local agent-server. Only fetched when the provider is selected.
  const isOpenRouter = selectedProvider === "openrouter";
  const { data: openRouterCatalog } = useOpenRouterCatalog(isOpenRouter);

  const openRouterInfoByName = React.useMemo(() => {
    const map = new Map<string, OpenRouterModelInfo>();
    for (const model of openRouterCatalog?.models ?? []) {
      map.set(model.id, model);
    }
    return map;
  }, [openRouterCatalog]);

  const unverifiedWithLive = React.useMemo(() => {
    const knownNames = new Set(
      [...verifiedModels, ...unverifiedModels].map((model) => model.name),
    );
    return [
      ...unverifiedModels,
      ...buildOpenRouterExtraModels(openRouterCatalog?.models, knownNames),
    ];
  }, [unverifiedModels, verifiedModels, openRouterCatalog]);

  const renderModelMeta = (modelName: string) => {
    if (!isOpenRouter) return null;
    const info = openRouterInfoByName.get(stripFloorSuffix(modelName));
    if (!info) return null;
    const parts: string[] = [];
    if (info.context_length) {
      parts.push(
        t(I18nKey.MODEL_SELECTOR$MODEL_CONTEXT, {
          context: formatContextLength(info.context_length),
        }),
      );
    }
    const pricing = formatPricePair(
      info.prompt_price_per_token,
      info.completion_price_per_token,
    );
    if (pricing) {
      parts.push(t(I18nKey.MODEL_SELECTOR$MODEL_PRICING, { pricing }));
    }
    if (parts.length === 0) return null;
    return (
      <span className="block text-xs text-[var(--oh-muted)]">
        {parts.join(" · ")}
      </span>
    );
  };

  React.useEffect(() => {
    if (currentModel) {
      const { provider, model } = extractModelAndProvider(currentModel);

      setLitellmId(currentModel);
      setSelectedProvider(provider || null);
      setSelectedModel(model);
      onDefaultValuesChanged?.(provider || null, model);
    }
  }, [currentModel]);

  const handleChangeProvider = (provider: string) => {
    setSelectedProvider(provider);
    setSelectedModel(null);
    setLitellmId(`${provider}/`);
    onChange?.(provider, null);
  };

  const handleChangeModel = (model: string) => {
    let fullModel = `${selectedProvider}/${model}`;
    if (selectedProvider === "openai") {
      fullModel = model;
    }
    setLitellmId(fullModel);
    setSelectedModel(model);
    onChange?.(selectedProvider, model);
  };

  const clear = () => {
    setSelectedProvider(null);
    setLitellmId(null);
  };


  return (
    <div
      className={cn(
        "flex flex-col md:flex-row w-full min-w-0 justify-between gap-4 md:gap-[46px]",
        wrapperClassName,
      )}
    >
      <fieldset className="flex flex-col gap-2.5 w-full">
        <label className={cn("text-sm", labelClassName)}>
          {t(I18nKey.LLM$PROVIDER)}
        </label>
        <Autocomplete
          data-testid="llm-provider-input"
          isRequired
          isVirtualized={false}
          name="llm-provider-input"
          isDisabled={isDisabled}
          aria-label={t(I18nKey.LLM$PROVIDER)}
          isClearable={false}
          onSelectionChange={(e) => {
            if (e?.toString()) handleChangeProvider(e.toString());
          }}
          onInputChange={(value) => !value && clear()}
          defaultSelectedKey={selectedProvider ?? undefined}
          selectedKey={selectedProvider}
          classNames={{
            popoverContent:
              "bg-content1 rounded-xl border border-[var(--oh-border)]",
            selectorButton: heroUiAutocompleteSelectorButtonClassName,
          }}
          selectorButtonProps={{ disableRipple: true }}
          inputProps={{
            classNames: {
              inputWrapper: formControlSettingsFieldClassName,
            },
          }}
        >
          <AutocompleteSection
            title={t(I18nKey.MODEL_SELECTOR$VERIFIED)}
            classNames={{ heading: "text-[var(--oh-muted)]" }}
          >
            {verifiedProviders.map((provider) => (
              <AutocompleteItem
                data-testid={`provider-item-${provider.name}`}
                key={provider.name}
              >
                {mapProvider(provider.name)}
              </AutocompleteItem>
            ))}
          </AutocompleteSection>
          {unverifiedProviders.length > 0 ? (
            <AutocompleteSection
              title={t(I18nKey.MODEL_SELECTOR$OTHERS)}
              classNames={{ heading: "text-[var(--oh-muted)]" }}
            >
              {unverifiedProviders.map((provider) => (
                <AutocompleteItem key={provider.name}>
                  {mapProvider(provider.name)}
                </AutocompleteItem>
              ))}
            </AutocompleteSection>
          ) : null}
        </Autocomplete>
      </fieldset>

      {selectedProvider === "openhands" && (
        <HelpLink
          testId="openhands-account-help"
          text={t(I18nKey.SETTINGS$NEED_OPENHANDS_ACCOUNT)}
          linkText={t(I18nKey.SETTINGS$CLICK_HERE)}
          href={PRODUCT_URL.PRODUCTION}
          size="settings"
          linkColor="white"
        />
      )}

      <fieldset className="flex flex-col gap-2.5 w-full">
        <label className={cn("text-sm", labelClassName)}>
          {t(I18nKey.LLM$MODEL)}
        </label>
        <Autocomplete
          data-testid="llm-model-input"
          isRequired
          isVirtualized={false}
          isLoading={isLoadingModels}
          name="llm-model-input"
          aria-label={t(I18nKey.LLM$MODEL)}
          isClearable={false}
          onSelectionChange={(e) => {
            if (e?.toString()) handleChangeModel(e.toString());
          }}
          isDisabled={isDisabled || !selectedProvider}
          selectedKey={selectedModel}
          defaultSelectedKey={selectedModel ?? undefined}
          classNames={{
            popoverContent:
              "bg-content1 rounded-xl border border-[var(--oh-border)]",
            selectorButton: heroUiAutocompleteSelectorButtonClassName,
          }}
          selectorButtonProps={{ disableRipple: true }}
          inputProps={{
            classNames: {
              inputWrapper: formControlSettingsFieldClassName,
            },
          }}
        >
          <AutocompleteSection
            title={t(I18nKey.MODEL_SELECTOR$VERIFIED)}
            classNames={{ heading: "text-[var(--oh-muted)]" }}
          >
            {verifiedModels.map((model) => (
              <AutocompleteItem key={model.name} textValue={model.name}>
                <div className="flex flex-col">
                  <span>{model.name}</span>
                  {renderModelMeta(model.name)}
                </div>
              </AutocompleteItem>
            ))}
          </AutocompleteSection>
          {unverifiedModels.length > 0 ? (
            <AutocompleteSection
              title={t(I18nKey.MODEL_SELECTOR$OTHERS)}
              classNames={{ heading: "text-[var(--oh-muted)]" }}
            >
              {unverifiedWithLive.map((model) => (
                <AutocompleteItem
                  data-testid={`model-item-${model.name}`}
                  key={model.name}
                  textValue={model.name}
                >
                  <div className="flex flex-col">
                    <span>{model.name}</span>
                    {renderModelMeta(model.name)}
                  </div>
                </AutocompleteItem>
              ))}
            </AutocompleteSection>
          ) : null}
        </Autocomplete>
        {isOpenRouter && selectedModel ? (
          <Checkbox
            data-testid="openrouter-floor-toggle"
            size="sm"
            isSelected={hasFloorSuffix(selectedModel)}
            onValueChange={(isSelected) => {
              handleChangeModel(
                applyFloorSuffix(
                  stripFloorSuffix(selectedModel),
                  Boolean(isSelected),
                ),
              );
            }}
            classNames={{ label: "text-sm text-[var(--oh-muted)]" }}
          >
            {t(I18nKey.MODEL_SELECTOR$OPENROUTER_FLOOR)}
          </Checkbox>
        ) : null}
        {modelsError && (
          <p data-testid="models-error" className="text-danger text-xs">
            {t(I18nKey.CONFIGURATION$ERROR_FETCH_MODELS)}
          </p>
        )}
      </fieldset>
    </div>
  );
}
