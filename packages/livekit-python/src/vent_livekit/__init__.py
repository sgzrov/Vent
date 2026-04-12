"""Vent helper for forwarding LiveKit Agents SDK observability."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("vent-livekit")

VENT_TOPICS = {
    "call_metadata": "vent:call-metadata",
    "debug_url": "vent:debug-url",
    "warning": "vent:warning",
    "metrics": "vent:metrics",
    "function_tools_executed": "vent:function-tools-executed",
    "conversation_item": "vent:conversation-item",
    "user_input_transcribed": "vent:user-input-transcribed",
    "session_usage": "vent:session-usage",
}


def _sanitize(value: Any, depth: int = 0) -> Any:
    if value is None or depth > 8:
        return value
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (list, tuple)):
        return [_sanitize(v, depth + 1) for v in value]
    if isinstance(value, set):
        return [_sanitize(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {str(k): _sanitize(v, depth + 1) for k, v in value.items()}
    if hasattr(value, "model_dump"):
        return _sanitize(value.model_dump(), depth + 1)
    if hasattr(value, "to_dict"):
        return _sanitize(value.to_dict(), depth + 1)
    if hasattr(value, "__dict__"):
        return _sanitize(
            {k: v for k, v in value.__dict__.items() if not k.startswith("_")},
            depth + 1,
        )
    return str(value)


def _compact(d: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    filtered = {k: v for k, v in d.items() if v is not None}
    return filtered if filtered else None


def _event_to_dict(event: Any) -> Dict[str, Any]:
    if isinstance(event, dict):
        return event
    if hasattr(event, "model_dump"):
        return event.model_dump()
    if hasattr(event, "to_dict"):
        return event.to_dict()
    if hasattr(event, "__dict__"):
        return {k: v for k, v in event.__dict__.items() if not k.startswith("_")}
    return {"value": event}


@dataclass
class VentLiveKitBridge:
    """Returned by instrument_livekit_agent(). Provides methods to publish
    additional observability data and to clean up event subscriptions."""

    _publish: Callable[..., Any] = field(repr=False)
    _teardown_fns: List[Callable[[], None]] = field(default_factory=list, repr=False)

    async def publish_call_metadata(self, metadata: Dict[str, Any]) -> None:
        call_metadata = _compact({"platform": "livekit", **metadata}) or {
            "platform": "livekit"
        }
        await self._publish(
            VENT_TOPICS["call_metadata"], {"call_metadata": call_metadata}
        )

    async def publish_debug_url(self, label: str, url: str) -> None:
        await self._publish(VENT_TOPICS["debug_url"], {"label": label, "url": url})

    async def publish_warning(
        self, message: str, extras: Optional[Dict[str, Any]] = None
    ) -> None:
        payload: Dict[str, Any] = {"message": message}
        if extras:
            payload.update(extras)
        await self._publish(VENT_TOPICS["warning"], payload)

    async def publish_session_usage(self, usage: Dict[str, Any]) -> None:
        await self._publish(VENT_TOPICS["session_usage"], {"usage": usage})

    def dispose(self) -> None:
        for fn in self._teardown_fns:
            fn()
        self._teardown_fns.clear()


def instrument_livekit_agent(
    *,
    ctx: Any = None,
    session: Any = None,
    room: Any = None,
    participant: Any = None,
    reliable: bool = True,
    session_metadata: Optional[Dict[str, Any]] = None,
    debug_urls: Optional[Dict[str, str]] = None,
) -> VentLiveKitBridge:
    """Instrument a LiveKit agent to forward observability events to Vent.

    Subscribes to session events (metrics, tool calls, conversation items,
    usage, close) and publishes them on ``vent:*`` DataChannel topics that
    the Vent LiveKit adapter already understands.

    Args:
        ctx: LiveKit ``JobContext``. Used for room, shutdown callback, and
            session report generation.
        session: LiveKit ``AgentSession``. Event source for metrics, tool
            calls, conversation items, transcription, and usage.
        room: LiveKit ``Room`` (alternative to ``ctx``).
        participant: LiveKit ``LocalParticipant`` (alternative to ``ctx``/``room``).
        reliable: Whether to use reliable DataChannel delivery. Default ``True``.
        session_metadata: Optional extra metadata to publish immediately.
        debug_urls: Optional ``{label: url}`` debug links to publish immediately.

    Returns:
        A :class:`VentLiveKitBridge` with methods for publishing additional
        data and a ``dispose()`` to unsubscribe from all events.
    """
    resolved_room = room or (ctx.room if ctx else None)
    resolved_participant = participant or (
        resolved_room.local_participant if resolved_room else None
    )

    if not resolved_participant:
        raise ValueError(
            "instrument_livekit_agent requires a LiveKit local_participant, room, or ctx."
        )

    teardown_fns: List[Callable[[], None]] = []

    async def publish(topic: str, payload: Dict[str, Any]) -> None:
        message = {"type": topic, **payload}
        sanitized = _sanitize(message)
        data = json.dumps(sanitized).encode("utf-8")
        await resolved_participant.publish_data(data, reliable=reliable, topic=topic)

    def safe_publish(topic: str, payload: Dict[str, Any], context: str) -> None:
        import asyncio

        async def _do() -> None:
            try:
                await publish(topic, payload)
            except Exception as exc:
                logger.warning("Failed to publish %s: %s", context, exc)

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(_do())
        except RuntimeError:
            pass

    bridge = VentLiveKitBridge(_publish=publish, _teardown_fns=teardown_fns)

    # ── Session event subscriptions ──────────────────────────────

    if session is not None:

        def _subscribe(event_name: str, handler: Callable[..., None]) -> None:
            session.on(event_name, handler)

            def _unsub() -> None:
                try:
                    session.off(event_name, handler)
                except Exception:
                    pass

            teardown_fns.append(_unsub)

        def _on_metrics(ev: Any) -> None:
            safe_publish(
                VENT_TOPICS["metrics"],
                {"event": "metrics_collected", **_event_to_dict(ev)},
                "metrics_collected event",
            )

        def _on_function_tools(ev: Any) -> None:
            ev_dict = _event_to_dict(ev)

            # Merge function_calls + function_call_outputs into a tool_calls
            # array that the Vent adapter can extract (name, arguments as dict,
            # result, successful).
            function_calls = ev_dict.get("function_calls") or []
            function_call_outputs = ev_dict.get("function_call_outputs") or []
            tool_calls = []
            for i, fc in enumerate(function_calls):
                if not isinstance(fc, dict):
                    fc = _event_to_dict(fc)
                output = (
                    function_call_outputs[i]
                    if i < len(function_call_outputs) and function_call_outputs[i] is not None
                    else None
                )
                if output is not None and not isinstance(output, dict):
                    output = _event_to_dict(output)

                args = fc.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except (json.JSONDecodeError, TypeError):
                        pass  # keep as string

                tool_calls.append({
                    "name": fc.get("name"),
                    "arguments": args,
                    "call_id": fc.get("call_id"),
                    "result": output.get("output") if output else None,
                    "successful": not output.get("is_error") if output else None,
                })

            safe_publish(
                VENT_TOPICS["function_tools_executed"],
                {
                    "event": "function_tools_executed",
                    "tool_calls": tool_calls if tool_calls else None,
                    **ev_dict,
                },
                "function_tools_executed event",
            )

        def _on_conversation_item(ev: Any) -> None:
            ev_dict = _event_to_dict(ev)
            # ChatMessage.content can contain AudioContent (rtc.AudioFrame)
            # and ImageContent (rtc.VideoFrame) which aren't JSON-serializable.
            # Strip them and keep only text content + metadata.
            item = ev_dict.get("item")
            if isinstance(item, dict) and "content" in item:
                item["content"] = [
                    c for c in item["content"]
                    if isinstance(c, str) or (isinstance(c, dict) and c.get("type") not in ("audio_content", "image_content"))
                ]
            elif hasattr(item, "content"):
                # Raw ChatMessage object — extract text only
                try:
                    ev_dict["item"] = {
                        "id": getattr(item, "id", None),
                        "type": getattr(item, "type", None),
                        "role": getattr(item, "role", None),
                        "content": [c for c in (item.content or []) if isinstance(c, str)],
                        "interrupted": getattr(item, "interrupted", False),
                        "metrics": _sanitize(getattr(item, "metrics", None)),
                        "created_at": getattr(item, "created_at", None),
                    }
                except Exception:
                    pass
            safe_publish(
                VENT_TOPICS["conversation_item"],
                {"event": "conversation_item_added", **ev_dict},
                "conversation_item_added event",
            )

        def _on_user_input(ev: Any) -> None:
            safe_publish(
                VENT_TOPICS["user_input_transcribed"],
                {"event": "user_input_transcribed", **_event_to_dict(ev)},
                "user_input_transcribed event",
            )

        def _on_session_usage(ev: Any) -> None:
            ev_dict = _event_to_dict(ev)
            usage = ev_dict.get("usage", ev_dict)
            safe_publish(
                VENT_TOPICS["session_usage"],
                {"usage": _sanitize(usage)},
                "session_usage_updated event",
            )

        def _on_close(ev: Any) -> None:
            ev_dict = _event_to_dict(ev)
            error = ev_dict.get("error")
            if error is not None:
                safe_publish(
                    VENT_TOPICS["warning"],
                    {
                        "message": "LiveKit session closed with error",
                        "error": _sanitize(error),
                    },
                    "close warning",
                )

        _subscribe("metrics_collected", _on_metrics)
        _subscribe("function_tools_executed", _on_function_tools)
        _subscribe("conversation_item_added", _on_conversation_item)
        _subscribe("user_input_transcribed", _on_user_input)
        _subscribe("session_usage_updated", _on_session_usage)
        _subscribe("close", _on_close)

    # ── Initial metadata / debug URLs ────────────────────────────

    if session_metadata:
        # Filter out signals the adapter already gets from the room
        filtered = dict(session_metadata)
        filtered.pop("platform", None)
        room_name = getattr(resolved_room, "name", None) or getattr(
            resolved_room, "sid", None
        )
        if (
            filtered.get("provider_session_id")
            and filtered["provider_session_id"] == room_name
        ):
            filtered.pop("provider_session_id", None)
        if _compact(filtered):
            safe_publish(
                VENT_TOPICS["call_metadata"],
                {
                    "call_metadata": _compact(
                        {"platform": "livekit", **filtered}
                    )
                    or {"platform": "livekit"}
                },
                "call metadata",
            )

    if debug_urls:
        for label, url in debug_urls.items():
            safe_publish(
                VENT_TOPICS["debug_url"],
                {"label": label, "url": url},
                f"debug url ({label})",
            )

    return bridge
