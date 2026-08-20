"""Mixin class for critic-related functionality in agents."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from openhands.sdk.critic.base import CriticResult
from openhands.sdk.event import ActionEvent, LLMConvertibleEvent, MessageEvent
from openhands.sdk.llm import content_to_str
from openhands.sdk.logger import get_logger
from openhands.sdk.tool import Action
from openhands.sdk.tool.builtins import FinishAction


if TYPE_CHECKING:
    from openhands.sdk.conversation import LocalConversation
    from openhands.sdk.critic.base import CriticBase


logger = get_logger(__name__)

# Key for storing iterative refinement iteration count in agent_state
ITERATIVE_REFINEMENT_ITERATION_KEY = "iterative_refinement_iteration"

# Marker a user can put at the start of a task prompt to enable autonomous
# continuation for THAT conversation only (no global env flag). When present,
# the agent, instead of finishing, keeps working by re-emitting a "continue"
# user message until it hits the per-conversation limit.
#
# The number of steps can be specified inline: `[AUTONOMOUS 15]` runs up to 15
# continuation steps, `[AUTONOMOUS]` (or `[AUTONOMOUS 0]`) uses the configured
# default. Case-insensitive.
AUTONOMOUS_MARKER = "[AUTONOMOUS]"
# Matches `[AUTONOMOUS]` or `[AUTONOMOUS 15]` (optional integer).
_AUTONOMOUS_MARKER_RE = re.compile(r"\[AUTONOMOUS(?:\s+(\d+))?\]", re.IGNORECASE)
# Key storing how many autonomous "continue" steps have been issued.
AUTONOMOUS_ITERATION_KEY = "autonomous_continuation_iteration"
# Default max autonomous continuation steps before the agent is allowed to
# finish (prevents infinite loops).
AUTONOMOUS_DEFAULT_MAX = 8
# Key storing a durable per-conversation flag that autonomous mode is active.
# Set the first time the [AUTONOMOUS] marker is seen and kept in agent_state so
# it survives LLM history condensation (which can summarize away the original
# user message that carried the marker) and only falls back to scanning the
# event stream on a resumed/older conversation.
AUTONOMOUS_ENABLED_KEY = "autonomous_enabled"
# Key storing the max-step override parsed from an inline `[AUTONOMOUS <N>]`
# marker. Persisted alongside the enabled flag so it survives condensation.
AUTONOMOUS_MARKER_MAX_STEPS_KEY = "autonomous_marker_max_steps"


def parse_autonomous_marker(text: str) -> int | None:
    """Parse the autonomous marker from ``text``.

    Returns the inline max-step count when ``[AUTONOMOUS <N>]`` is present, ``0``
    when plain ``[AUTONOMOUS]`` (or ``[AUTONOMOUS 0]``) is present (meaning "use
    the configured default"), and ``None`` when the marker is absent.
    """
    m = _AUTONOMOUS_MARKER_RE.search(text or "")
    if not m:
        return None
    return int(m.group(1)) if m.group(1) else 0


class CriticMixin:
    """Mixin providing critic evaluation and iterative refinement functionality.

    This mixin is designed to be used with Agent classes that have a `critic`
    attribute of type CriticBase | None.
    """

    critic: CriticBase | None

    def _should_evaluate_with_critic(self, action: Action | None) -> bool:
        """Determine if critic should evaluate based on action type and mode."""
        if self.critic is None:
            return False

        if self.critic.mode == "all_actions":
            return True

        # For "finish_and_message" mode, only evaluate FinishAction
        # (MessageEvent will be handled separately in step())
        if isinstance(action, FinishAction):
            return True

        return False

    def _evaluate_with_critic(
        self, conversation: LocalConversation, event: ActionEvent | MessageEvent
    ) -> CriticResult | None:
        """Run critic evaluation on the current event and history."""
        if self.critic is None:
            return None

        try:
            # Build event history including the current event
            events = list(conversation.state.events) + [event]
            llm_convertible_events = [
                e for e in events if isinstance(e, LLMConvertibleEvent)
            ]

            # Evaluate without git_patch for now
            critic_result = self.critic.evaluate(
                events=llm_convertible_events, git_patch=None
            )
            logger.info(
                f"✓ Critic evaluation: score={critic_result.score:.3f}, "
                f"success={critic_result.success}"
            )
            return critic_result
        except Exception as e:
            logger.error(f"✗ Critic evaluation failed: {e}", exc_info=True)
            return None

    def _check_iterative_refinement(
        self, conversation: LocalConversation, action_event: ActionEvent
    ) -> tuple[bool, str | None]:
        """Check if iterative refinement should continue after a FinishAction.

        This method checks the critic result and determines whether to continue
        with another iteration. State mutation (incrementing the iteration counter)
        only occurs when refinement will actually continue.

        Returns:
            A tuple of (should_continue, followup_message).
            If should_continue is True, the agent should continue with the
            followup_message instead of finishing.
        """
        # Autonomous continuation (per-conversation marker, no global flag).
        # If the user started the task with the [AUTONOMOUS] marker, keep the
        # agent working by re-emitting a "continue" user message instead of
        # letting it finish, up to a per-conversation limit.
        autonomous = self._check_autonomous_continue(conversation)
        if autonomous is not None:
            return autonomous

        # Check if critic has iterative refinement config
        if self.critic is None or self.critic.iterative_refinement is None:
            return False, None

        config = self.critic.iterative_refinement
        state = conversation.state

        # Get current iteration count (0-indexed)
        iteration = state.agent_state.get(ITERATIVE_REFINEMENT_ITERATION_KEY, 0)

        # Check if we've exceeded max iterations BEFORE incrementing
        if iteration >= config.max_iterations:
            logger.info(
                f"Iterative refinement: max iterations "
                f"({config.max_iterations}) reached"
            )
            return False, None

        # Get the critic result from the action event
        critic_result = action_event.critic_result
        if critic_result is None:
            logger.warning("Iterative refinement: no critic result on FinishAction")
            return False, None

        if not self.critic.should_refine(critic_result):
            logger.info(
                f"Iterative refinement: success threshold "
                f"({config.success_threshold:.0%}) met with score "
                f"{critic_result.score:.3f}"
            )
            return False, None

        # Refinement is needed and we haven't hit max iterations
        # NOW we increment the counter since we're actually continuing
        # Use reassignment pattern to trigger autosave
        new_iteration = iteration + 1
        state.agent_state = {
            **state.agent_state,
            ITERATIVE_REFINEMENT_ITERATION_KEY: new_iteration,
        }

        logger.info(
            "Iterative refinement: continuing after critic evaluation "
            f"(score={critic_result.score:.3f}, "
            f"threshold={config.success_threshold:.3f}, "
            f"iteration {new_iteration}/{config.max_iterations})"
        )
        followup = self.critic.get_followup_prompt(critic_result, new_iteration)
        return True, followup

    def _check_autonomous_continue(
        self, conversation: LocalConversation
    ) -> tuple[bool, str | None] | None:
        """Autonomous per-conversation continuation (no global env flag).

        If the task prompt contains the ``[AUTONOMOUS]`` marker, the agent
        keeps working instead of finishing: ``finalize`` re-emits a "continue"
        user message up to ``max_steps`` times. Returns None when the marker is
        absent (fall through to normal finish/critic logic).

        Returns:
            (should_continue, followup) when autonomous mode applies, else None.
        """
        state = conversation.state

        # Durable flag first (set once when the marker was first seen). Kept in
        # agent_state so LLM history condensation — which may summarize away the
        # original [AUTONOMOUS] user message — cannot silently turn autonomous
        # mode off mid-task. Only fall back to scanning the event stream for a
        # conversation that predates the flag (e.g. resumed old session).
        autonomous_enabled = state.agent_state.get(AUTONOMOUS_ENABLED_KEY)

        # Scan the user message stream for the latest [AUTONOMOUS]/[AUTONOMOUS N]
        # marker. This is re-run on every finish attempt so the marker can be
        # issued (or its step budget changed) from ANYWHERE in the dialog, not
        # just the first message. An inline `[AUTONOMOUS N]` always wins over the
        # stored value.
        latest_marker_steps: int | None = None
        for event in state.active_branch():
            if isinstance(event, MessageEvent) and event.source == "user":
                # content_to_str returns a LIST of strings; join before the
                # substring check, otherwise `in` does list-membership
                # (equality) instead of substring and the [AUTONOMOUS]
                # marker is never detected → autonomous mode never turns on.
                text = " ".join(content_to_str(event.llm_message.content)) or ""
                parsed = parse_autonomous_marker(text)
                if parsed is not None:
                    latest_marker_steps = parsed

        if not autonomous_enabled:
            marker_seen = latest_marker_steps is not None
            if not marker_seen:
                return None
            # Persist the flag (and any inline max-step override) so it survives
            # later condensation.
            update: dict = {AUTONOMOUS_ENABLED_KEY: True}
            if latest_marker_steps:
                update[AUTONOMOUS_MARKER_MAX_STEPS_KEY] = latest_marker_steps
            state.agent_state = {**state.agent_state, **update}
        elif latest_marker_steps is not None:
            # Marker present in a later user message — update the step budget.
            stored = int(state.agent_state.get(AUTONOMOUS_MARKER_MAX_STEPS_KEY, 0) or 0)
            if latest_marker_steps != stored:
                state.agent_state = {
                    **state.agent_state,
                    AUTONOMOUS_MARKER_MAX_STEPS_KEY: latest_marker_steps,
                }
        steps = state.agent_state.get(AUTONOMOUS_ITERATION_KEY, 0)
        # Resolution: inline marker `[AUTONOMOUS N]` > explicit per-conversation
        # agent_state override > the agent's configured autonomous_max_steps
        # (set via settings → UI) > the module-level default.
        marker_steps = int(
            state.agent_state.get(AUTONOMOUS_MARKER_MAX_STEPS_KEY, 0) or 0
        )
        max_steps = (
            marker_steps
            or int(state.agent_state.get("autonomous_max_steps", 0) or 0)
            or (getattr(self, "autonomous_max_steps", None) or AUTONOMOUS_DEFAULT_MAX)
        )

        if steps >= max_steps:
            logger.info(
                f"Autonomous continuation: reached limit ({max_steps}), finishing"
            )
            return False, None

        new_steps = steps + 1
        state.agent_state = {
            **state.agent_state,
            AUTONOMOUS_ITERATION_KEY: new_steps,
        }
        logger.info(
            f"Autonomous continuation: step {new_steps}/{max_steps}, "
            "re-emitting continue message"
        )
        followup = (
            "[Автономный режим] Задача ещё не завершена. Продолжай работу "
            "самостоятельно: выполняй оставшиеся шаги, проверяй результаты, "
            "и только когда реально закончишь — вызови finish с итоговым "
            "отчётом. Не останавливайся на промежуточных этапах."
        )
        return True, followup
