from uuid import uuid4

from pydantic import Field

from openhands.sdk.context.condenser.base import CondenserBase
from openhands.sdk.context.condenser.utils import (
    get_suffix_length_for_token_reduction,
    get_total_token_count,
)
from openhands.sdk.context.view.view import View
from openhands.sdk.event.condenser import Condensation
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
    total does not exceed ``max_size`` events. When ``max_tokens`` and the
    agent LLM are available it also (or instead) trims by token count — using
    the tokenizer for counting only, never making completion calls. Truncation
    is recomputed on every step from the intact history, which makes it fully
    reversible: switching back to a summarizing condenser (or raising
    ``max_size``) restores access to the older events.

    Cuts respect view manipulation indices, so an atomic unit (e.g. an action
    and its observation) is never split in half.

    Explicit condensation requests (user/agent pressing "condense now") are
    handled by emitting a :class:`Condensation` event that permanently forgets
    half of the trimmable history. The event is what clears the request flag —
    a plain trimmed ``View`` would leave it set forever.
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
    max_tokens: int | None = Field(
        default=None,
        gt=0,
        description=(
            "Also trim when the view exceeds this many tokens (counted with "
            "the agent LLM's tokenizer — no completion calls). When exceeded, "
            "the view is cut down to half the budget."
        ),
    )

    def handles_condensation_requests(self) -> bool:
        return True

    def condense(self, view: View, agent_llm: LLM | None = None) -> View | Condensation:
        handle_request = view.unhandled_condensation_request
        keep_n_events = max(1, self.max_size - self.keep_first)

        # Naive trim start (exclusive): keep head + the last keep_n_events.
        # Stays past the end when the view is under the event limit.
        naive_end = len(view) - keep_n_events
        must_cut = len(view) > self.keep_first + keep_n_events

        # Token pressure. Token *counting* uses the agent LLM's tokenizer —
        # no completion calls are made (the condenser stays LLM-free).
        if self.max_tokens and agent_llm is not None:
            total_tokens = get_total_token_count(view.events, agent_llm)
            if total_tokens > self.max_tokens:
                must_cut = True
                token_based_end = len(view) - get_suffix_length_for_token_reduction(
                    events=view.events[self.keep_first :],
                    llm=agent_llm,
                    token_reduction=total_tokens - (self.max_tokens // 2),
                    base_events=view.events[: self.keep_first],
                )
                if naive_end > self.keep_first:
                    # Both constraints apply: pick the stricter cut.
                    naive_end = min(naive_end, token_based_end)
                else:
                    naive_end = token_based_end

        # Explicit condensation request (user/agent asked): halve the
        # trimmable history even when under the event/token limits.
        if handle_request:
            must_cut = True
            target_end = len(view) // 2
            if naive_end <= self.keep_first or target_end < naive_end:
                naive_end = max(target_end, self.keep_first + 1)

        if not must_cut or naive_end <= self.keep_first:
            if not handle_request:
                return view
            # Nothing can be forgotten, but the request still must be
            # answered with a Condensation event to clear the flag.
            return self._acknowledge_request(view, forgotten_ids=set())

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
            if handle_request:
                return self._acknowledge_request(view, forgotten_ids=set())
            return view

        if end <= start:
            if handle_request:
                return self._acknowledge_request(view, forgotten_ids=set())
            return view

        forgotten_ids = {event.id for event in view[start:end]}

        if handle_request:
            # Persist the trim via a Condensation event: this clears the
            # request flag and permanently forgets the dropped events.
            logger.info(
                "RecentEventsCondenser handling explicit condensation "
                "request: forgetting %d events",
                len(forgotten_ids),
            )
            return self._acknowledge_request(view, forgotten_ids=forgotten_ids)

        logger.debug(
            "RecentEventsCondenser trimmed view from %d to %d events "
            "(keep_first=%d, max_size=%d, max_tokens=%s)",
            len(view),
            len(view) - (end - start),
            self.keep_first,
            self.max_size,
            self.max_tokens,
        )
        return View(events=[*view.events[:start], *view.events[end:]])

    @staticmethod
    def _acknowledge_request(
        view: View, forgotten_ids: set[str]
    ) -> Condensation:
        """Build the Condensation that answers an explicit request.

        With ``forgotten_ids`` the trim becomes permanent (the user asked for
        it); with an empty set it only clears the request flag.
        """
        return Condensation(
            forgotten_event_ids=forgotten_ids,
            summary=None,
            summary_offset=None,
            llm_response_id=f"recent-events-condenser-{uuid4()}",
        )
