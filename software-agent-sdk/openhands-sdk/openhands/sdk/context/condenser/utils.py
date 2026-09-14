import json
from collections.abc import Sequence

from openhands.sdk.event.base import LLMConvertibleEvent
from openhands.sdk.event.llm_convertible.system import SystemPromptEvent
from openhands.sdk.llm import LLM


def get_total_token_count(
    events: Sequence[LLMConvertibleEvent],
    llm: LLM,
) -> int:
    """Calculate the total token count for a list of LLM convertible events.

    This function converts the events to LLM messages and uses the provided LLM
    to count the total number of tokens. This is useful for understanding how many
    tokens a sequence of events will consume in the context window. A view is
    expected to have one system prompt event; if multiple are present, only the
    first system prompt's tools are included.

    Args:
        events: List of LLM convertible events to count tokens for
        llm: The LLM instance to use for token counting (uses the litellm's token
            counting utilities)

    Returns:
        Total token count for all events converted to messages

    Example:
        >>> from openhands.sdk.llm import LLM
        >>> from openhands.sdk.event.llm_convertible import MessageEvent
        >>>
        >>> llm = LLM(model="gpt-4")
        >>> events = [
        ...     MessageEvent.from_text("Hello, how are you?", source="user"),
        ...     MessageEvent.from_text("I'm doing great!", source="agent"),
        ... ]
        >>> token_count = get_total_token_count(events, llm)
        >>> print(f"Total tokens: {token_count}")
    """
    messages = LLMConvertibleEvent.events_to_messages(list(events))
    tools = next(
        (event.tools for event in events if isinstance(event, SystemPromptEvent)),
        None,
    )
    return llm.get_token_count(
        messages,
        tools=tools or None,
        # Security-risk tokens are always included in real tool requests.
        add_security_risk_prediction=bool(tools),
    )


def get_shortest_prefix_above_token_count(
    events: Sequence[LLMConvertibleEvent],
    llm: LLM,
    token_count: int,
    base_events: Sequence[LLMConvertibleEvent] | None = None,
) -> int:
    """Find the length of the shortest prefix whose token count exceeds the target.

    This function performs a binary search to efficiently find the shortest prefix
    of events that, when converted to messages, has a total token count greater than
    the specified target token count.

    Args:
        events: List of LLM convertible events to search through
        llm: The LLM instance to use for token counting (uses the model's tokenizer)
        token_count: The target token count threshold

    Returns:
        The length of the shortest prefix that exceeds the token count.
        Returns 0 if no events are provided.
        Returns len(events) if all events combined don't exceed the token count.

    Example:
        >>> from openhands.sdk.llm import LLM
        >>> from openhands.sdk.event.llm_convertible import MessageEvent
        >>>
        >>> llm = LLM(model="gpt-4")
        >>> events = [
        ...     MessageEvent.from_text("Hi", source="user"),
        ...     MessageEvent.from_text("Hello", source="agent"),
        ...     MessageEvent.from_text("How are you?", source="user"),
        ...     MessageEvent.from_text("Great!", source="agent"),
        ... ]
        >>> prefix_len = get_shortest_prefix_above_token_count(events, llm, 20)
        >>> # prefix_len might be 2 if first 2 events exceed 20 tokens
    """
    if not events:
        return 0

    base_events = base_events or []
    base_tokens = get_total_token_count(base_events, llm) if base_events else 0

    # Check if all events combined don't exceed the token count
    total_tokens = get_total_token_count([*base_events, *events], llm) - base_tokens
    if total_tokens <= token_count:
        return len(events)

    # Binary search for the shortest prefix
    left, right = 1, len(events)

    while left < right:
        mid = (left + right) // 2
        prefix_tokens = (
            get_total_token_count([*base_events, *events[:mid]], llm) - base_tokens
        )

        if prefix_tokens > token_count:
            # This prefix exceeds the count, try to find a shorter one
            right = mid
        else:
            # This prefix doesn't exceed, we need a longer one
            left = mid + 1

    return left


def get_suffix_length_for_token_reduction(
    events: Sequence[LLMConvertibleEvent],
    llm: LLM,
    token_reduction: int,
    base_events: Sequence[LLMConvertibleEvent] | None = None,
) -> int:
    """Find how many suffix events can be kept while reducing tokens by target amount.

    This function determines the maximum number of events from the end of the list
    that can be retained while ensuring the total token count is reduced by at least
    the specified amount. It uses the get_shortest_prefix_above_token_count function
    to find the prefix that must be removed.

    Args:
        events: List of LLM convertible events
        llm: The LLM instance to use for token counting (uses the model's tokenizer)
        token_reduction: The minimum number of tokens to reduce by

    Returns:
        The number of events from the end that can be kept (suffix length).

    Example:
        >>> from openhands.sdk.llm import LLM
        >>> from openhands.sdk.event.llm_convertible import MessageEvent
        >>>
        >>> llm = LLM(model="gpt-4")
        >>> events = [
        ...     MessageEvent.from_text("Event 1", source="user"),
        ...     MessageEvent.from_text("Event 2", source="agent"),
        ...     MessageEvent.from_text("Event 3", source="user"),
        ...     MessageEvent.from_text("Event 4", source="agent"),
        ... ]
        >>> # Suppose total is 100 tokens, and we want to reduce by 40 tokens
        >>> suffix_len = get_suffix_length_for_token_reduction(events, llm, 40)
        >>> # suffix_len tells us how many events from the end we can keep
        >>> # If first 2 events = 45 tokens, suffix_len = 2 (keep last 2 events)
    """
    if not events:
        return 0

    if token_reduction <= 0:
        return len(events)

    # Find the shortest prefix that exceeds the token reduction target
    prefix_length = get_shortest_prefix_above_token_count(
        events,
        llm,
        token_reduction,
        base_events=base_events,
    )

    # The suffix length is what remains after removing the prefix
    suffix_length = len(events) - prefix_length

    return suffix_length


# ---------------------------------------------------------------------------
# Compact event rendering for summarization prompts
# ---------------------------------------------------------------------------

def _shorten(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"... [+{len(text) - limit} chars]"


def render_event_for_summary(
    event: LLMConvertibleEvent,
    text_limit: int = 600,
    args_limit: int = 240,
    max_event_str_length: int | None = None,
) -> str:
    """Render one event as a compact, information-dense line for a summary.

    Full ``str(event)`` dumps are pydantic reprs full of ids and metadata: they
    waste the summarizer's input window and drown small local models in noise,
    which produces vague summaries and makes the agent repeat finished work.
    This keeps the signal: who said what, which tool ran with which arguments,
    what the tool returned (truncated).
    """
    kind = type(event).__name__

    if isinstance(event, SystemPromptEvent):
        parts = [getattr(event, "system_prompt", "") or ""]
        for block in getattr(event, "dynamic_context", None) or []:
            text = getattr(block, "text", None)
            if text:
                parts.append(text)
        return f"SYSTEM PROMPT: {_shorten(' '.join(parts), 300)}"

    source = getattr(event, "source", "")
    # MessageEvent (user/assistant)
    if kind == "MessageEvent":
        role = source or "message"
        parts = []
        blocks = list(getattr(event, "content", None) or [])
        llm_message = getattr(event, "llm_message", None)
        if llm_message is not None:
            blocks += list(getattr(llm_message, "content", None) or [])
        blocks += list(getattr(event, "extended_content", None) or [])
        for block in blocks:
            text = getattr(block, "text", None)
            if text:
                parts.append(text)
        return f"{role.upper()}: {_shorten(' '.join(parts), text_limit)}"

    # ActionEvent: the tool invocation and its arguments
    if kind == "ActionEvent":
        tool_name = getattr(event, "tool_name", "") or "unknown"
        tool_call = getattr(event, "tool_call", None)
        args = getattr(tool_call, "arguments", None)
        if isinstance(args, str):
            args_str = args
        else:
            try:
                args_str = json.dumps(args, ensure_ascii=False, default=str)
            except Exception:
                args_str = str(args)
        return f"ACTION {tool_name} args={_shorten(args_str or '{}', args_limit)}"

    # ObservationEvent: the tool result
    if kind == "ObservationEvent":
        tool_name = getattr(event, "tool_name", "") or "unknown"
        observation = getattr(event, "observation", None)
        text = ""
        to_llm = getattr(observation, "to_llm_content", None)
        if to_llm:
            from openhands.sdk.llm import content_to_str

            text = "".join(content_to_str(list(to_llm)))
        total = len(text)
        shown = _shorten(text, text_limit)
        if total > len(shown):
            shown = f"{shown} [total {total} chars]"
        return f"RESULT {tool_name}: {shown}"

    # Condensation: the previous rolling summary
    if kind == "Condensation":
        summary = getattr(event, "summary", "") or ""
        return f"PREVIOUS SUMMARY: {_shorten(summary, text_limit)}"

    # Think / reasoning events
    if "Think" in kind:
        parts = []
        for block in getattr(event, "thought", None) or []:
            text = getattr(block, "text", None)
            if text:
                parts.append(text)
        return f"THOUGHT: {_shorten(' '.join(parts), 300)}"

    fallback = str(event)
    if max_event_str_length:
        fallback = fallback[:max_event_str_length]
    return f"{kind}: {_shorten(fallback, text_limit)}"
