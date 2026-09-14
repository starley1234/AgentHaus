from pydantic import Field

from openhands.sdk.context.condenser.base import CondenserBase
from openhands.sdk.context.view.view import View
from openhands.sdk.event.llm_convertible.observation import ObservationEvent
from openhands.sdk.llm import LLM, TextContent, content_to_str
from openhands.sdk.logger import get_logger


logger = get_logger(__name__)

DEFAULT_MASK_TEMPLATE = (
    "[Masked: the {tool_name} result originally contained {chars} characters "
    "of output. It was trimmed to save context; the tool call above is "
    "preserved. Re-run the tool if you need the output again.]"
)


class ObservationMaskingCondenser(CondenserBase):
    """Condenser that masks long tool outputs of older steps — no LLM calls.

    Instead of deleting events, every :class:`ObservationEvent` except the most
    recent ``keep_latest`` ones has its content replaced with a short placeholder
    whenever the textual output is longer than ``max_chars`` characters. The
    action/tool-call events stay fully intact, so the model still sees *that*
    the tool was invoked and with which arguments — only the bulky output is
    hidden. This preserves the conversation structure (tool_call ↔ result
    pairing, atomicity) while reclaiming most of the context window.

    Like :class:`RecentEventsCondenser` this never calls an LLM, and the
    original event history is never modified: masking is recomputed on every
    step from the intact history.

    Explicit condensation requests are *not* handled here: masking is a
    view-local transform, so it cannot persistently answer a request (the
    unhandled-request flag only clears via a ``Condensation`` event). In a
    pipeline the downstream LLM summarizer answers instead; in standalone
    masking mode the flag is passed through untouched.
    """

    keep_latest: int = Field(
        default=3,
        ge=0,
        description=(
            "Number of most recent tool results to always keep unmasked. "
            "0 masks every oversized result except the very last one."
        ),
    )
    max_chars: int = Field(
        default=500,
        gt=0,
        description=(
            "Results longer than this many characters are replaced with a "
            "short placeholder (unless they are within ``keep_latest``)."
        ),
    )
    mask_template: str = Field(
        default=DEFAULT_MASK_TEMPLATE,
        description="Placeholder text template; receives {tool_name} and {chars}.",
    )

    def condense(self, view: View, agent_llm: LLM | None = None) -> View:  # noqa: ARG002
        observation_indices = [
            index
            for index, event in enumerate(view.events)
            if isinstance(event, ObservationEvent)
        ]

        # Keep the newest `keep_latest` observations intact.
        candidates = (
            observation_indices[: -self.keep_latest]
            if self.keep_latest > 0
            else observation_indices[:-1]
        )
        if not candidates:
            return view

        events = list(view.events)
        masked_count = 0
        for index in candidates:
            event = events[index]
            if not isinstance(event, ObservationEvent):
                continue

            text = "".join(content_to_str(event.observation.to_llm_content))
            if len(text) <= self.max_chars:
                continue

            mask_text = self.mask_template.format(
                tool_name=event.tool_name,
                chars=len(text),
            )
            # model_copy preserves the concrete observation subclass (and its
            # discriminator `kind`), so serialized views stay valid.
            masked_observation = event.observation.model_copy(
                update={"content": [TextContent(text=mask_text)]}
            )
            events[index] = event.model_copy(
                update={"observation": masked_observation}
            )
            masked_count += 1

        if masked_count == 0:
            return view

        logger.debug(
            "ObservationMaskingCondenser masked %d/%d tool results "
            "(keep_latest=%d, max_chars=%d)",
            masked_count,
            len(observation_indices),
            self.keep_latest,
            self.max_chars,
        )
        return View(
            events=events,
            # Pass the flag through: in a pipeline the downstream condenser
            # (e.g. the LLM summarizer) must still see pending requests.
            unhandled_condensation_request=view.unhandled_condensation_request,
        )
