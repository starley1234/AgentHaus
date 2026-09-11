from pydantic import Field

from openhands.sdk.context.condenser.base import CondenserBase
from openhands.sdk.context.view.view import View
from openhands.sdk.llm import LLM
from openhands.sdk.logger import get_logger


logger = get_logger(__name__)


class RecentEventsCondenser(CondenserBase):
    """Condenser that drops older events from the LLM view without summarizing.

    Unlike :class:`LLMSummarizingCondenser`, this condenser never calls an LLM —
    it is free and instant, at the cost of losing the details of dropped events
    from the model's context (the full event history is kept on disk).

    The view passed to the LLM keeps the first ``keep_first`` events (typically
    the system prompt and the task) plus the most recent events, so that the
    total does not exceed ``max_size`` events. Truncation is recomputed on every
    step from the intact history, which makes it fully reversible: switching
    back to a summarizing condenser (or raising ``max_size``) restores access to
    the older events.

    Cuts respect view manipulation indices, so an atomic unit (e.g. an action
    and its observation) is never split in half.
    """

    keep_first: int = Field(
        default=2,
        ge=0,
        description=(
            "Minimum number of initial events to always preserve "
            "(e.g. system prompt / task)."
        ),
    )
    max_size: int = Field(
        default=240,
        gt=0,
        description=(
            "Maximum total number of events to expose to the LLM: the first "
            "``keep_first`` events plus the most recent ones."
        ),
    )

    def condense(self, view: View, agent_llm: LLM | None = None) -> View:  # noqa: ARG002
        keep_n_events = max(1, self.max_size - self.keep_first)
        if len(view) <= self.keep_first + keep_n_events:
            return view

        naive_end = len(view) - keep_n_events
        manipulation_indices = view.manipulation_indices
        try:
            # Never split an atomic unit: round the cut points to safe
            # manipulation indices, mirroring LLMSummarizingCondenser.
            start = manipulation_indices.find_next(self.keep_first)
            end = manipulation_indices.find_next(naive_end)
        except ValueError:
            # No safe cut point — expose the uncondensed view this step.
            logger.debug(
                "RecentEventsCondenser found no safe manipulation index "
                "(keep_first=%d, naive_end=%d, view size=%d)",
                self.keep_first,
                naive_end,
                len(view),
            )
            return view

        if end <= start:
            return view

        return View(events=[*view.events[:start], *view.events[end:]])
