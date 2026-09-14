import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SchemaField } from "#/components/features/settings/sdk-settings/schema-field";
import { SettingsFieldSchema } from "#/types/settings";

vi.mock("#/hooks/query/use-llm-profiles", () => ({
  useLlmProfiles: () => ({
    data: {
      profiles: [
        { name: "cheap", model: "gpt-4o-mini" },
        { name: "fancy", model: "claude-opus-4" },
      ],
    },
    isLoading: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      ({
        SETTINGS$TOP_P_LABEL: "Top P",
        SETTINGS$TOP_P_DESCRIPTION: "Controls nucleus sampling.",
        SCHEMA$VERIFICATION$CRITIC_API_KEY$HELP_TEXT:
          "If OpenHands is selected as your active LLM provider, leave this empty because the Critic API Key is the same as your OpenHands Provider LLM Key, which you can find in the",
        SCHEMA$VERIFICATION$CRITIC_API_KEY$HELP_SUFFIX:
          "tab of OpenHands Cloud; otherwise, enter a Critic API Key from that page.",
        SETTINGS$NAV_API_KEYS: "API Keys",
        SETTINGS$CONDENSER_LLM_PROFILE_USE_CONVERSATION:
          "Conversation LLM (default)",
        SCHEMA$CONDENSER$LLM_PROFILE$LABEL: "Condenser LLM profile",
        SCHEMA$CONDENSER$LLM_PROFILE$DESCRIPTION:
          "Saved LLM profile that generates the summaries.",
        SETTINGS$TITLE_GENERATION_PROFILE_OPTION: `${options?.name} \u00b7 ${options?.model}`,
      })[key] ?? key,
  }),
}));

function buildField(
  overrides: Partial<SettingsFieldSchema> = {},
): SettingsFieldSchema {
  return {
    key: "llm.top_p",
    label: "Top P",
    description: "Controls nucleus sampling.",
    section: "llm",
    section_label: "LLM",
    value_type: "number",
    default: 1,
    choices: [],
    depends_on: [],
    prominence: "major",
    secret: false,
    required: false,
    ...overrides,
  };
}

describe("SchemaField", () => {
  it("constrains the Top P input to the valid numeric range", () => {
    render(
      <SchemaField
        field={buildField()}
        value="1"
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    const input = screen.getByTestId("sdk-settings-llm.top_p");

    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "1");
    expect(input).toHaveAttribute("step", "0.01");
  });

  it("translates schema-backed labels and descriptions", () => {
    render(
      <SchemaField
        field={buildField({
          label: "SETTINGS$TOP_P_LABEL",
          description: "SETTINGS$TOP_P_DESCRIPTION",
        })}
        value="1"
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("Top P")).toBeInTheDocument();
    expect(screen.getByText("Controls nucleus sampling.")).toBeInTheDocument();
  });

  it("renders critic API key guidance as one settings-sized help line", () => {
    render(
      <SchemaField
        field={buildField({
          key: "verification.critic_api_key",
          label: "Critic API Key",
          description: "Server schema description should be replaced.",
          value_type: "string",
          secret: true,
        })}
        value=""
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    const help = screen.getByTestId("help-link-verification.critic_api_key");

    expect(help).toHaveTextContent(
      "Critic API Key is the same as your OpenHands Provider LLM Key",
    );
    expect(help).toHaveTextContent("API Keys");
    expect(help).toHaveClass("text-sm");
    expect(help).toHaveClass("font-normal");
    expect(
      screen.queryByText("Server schema description should be replaced."),
    ).not.toBeInTheDocument();
  });
  it("renders the condenser LLM profile as a dropdown of saved profiles", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SchemaField
        field={buildField({
          key: "condenser.llm_profile",
          label: "Condenser LLM profile",
          value_type: "string",
        })}
        value=""
        isDisabled={false}
        onChange={onChange}
      />,
    );

    const input = screen.getByLabelText("Condenser LLM profile");
    expect(input).toHaveValue("Conversation LLM (default)");

    await user.click(input);
    await user.click(await screen.findByText("cheap \u00b7 gpt-4o-mini"));

    expect(onChange).toHaveBeenCalledWith("cheap");
  });

  it("shows a dangling condenser profile as the current selection", () => {
    render(
      <SchemaField
        field={buildField({
          key: "condenser.llm_profile",
          label: "Condenser LLM profile",
          value_type: "string",
        })}
        value="deleted-profile"
        isDisabled={false}
        onChange={() => {}}
      />,
    );

    const input = screen.getByLabelText("Condenser LLM profile");
    expect(input).toHaveValue("deleted-profile");
  });
});
