"""A minimal server-sent-events frame parser — Python port of the shipped Node SDK's
`SseFrameParser` (`sdks/node/src/sse-parser.ts`). `push()` semantics are identical: feed it
decoded text chunks (which may split a frame, or even a single line, across chunk boundaries —
exactly how a streamed HTTP response body arrives) and it yields complete frames as they
become available. This identical chunking-tolerant design is what lets this parser consume the
exact same shared `test-vectors/sse-frames.json` vectors as Node (cross-language parity proof).

Comment lines (leading `:`, used by the server for `: heartbeat` keep-alives) are consumed and
produce no frame. Deliberately NOT a general-purpose SSE client — no `id:`/`retry:` handling,
no Last-Event-ID replay (the server doesn't support replay either).

Adds AC-SEC-SDK3-2(b) (`THREATMODEL-envpit-0t2z-3.md` F2): a per-line byte cap (default 64
KiB) — an adversarial/misbehaving server sending an unterminated line must not grow this
buffer unbounded in memory. Node itself does not yet have this cap (a documented parity-gap,
routed to bd:envpit-aw7l); this SDK must not reproduce that gap.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_EVENT_NAME = "message"
DEFAULT_MAX_LINE_BYTES = 64 * 1024


@dataclass(frozen=True)
class SseFrame:
    event: str
    data: str


class SseLineTooLongError(Exception):
    """Raised when a single SSE line exceeds the configured byte cap without a terminating
    newline. The caller (`RealtimeTransport`) treats this exactly like any other stream
    failure — drop the connection, reconnect via the existing degraded/backoff path. No new
    connection states are needed (AC-SEC-SDK3-2)."""


class SseFrameParser:
    def __init__(self, max_line_bytes: int = DEFAULT_MAX_LINE_BYTES) -> None:
        self._buffer = ""
        self._event_name = DEFAULT_EVENT_NAME
        self._data_lines: list[str] = []
        self._saw_any_field = False
        self._max_line_bytes = max_line_bytes

    def push(self, chunk: str) -> list[SseFrame]:
        """Feed a decoded text chunk; returns any complete frames it produced (zero, one, or
        many). Raises `SseLineTooLongError` if the in-progress line has grown past the byte
        cap without a terminator — the internal buffer is reset first so the parser is left in
        a clean state for the caller to decide what happens next (reconnect)."""
        self._buffer += chunk
        frames: list[SseFrame] = []

        while True:
            newline_index = self._buffer.find("\n")
            if newline_index == -1:
                break
            raw_line = self._buffer[:newline_index]
            self._buffer = self._buffer[newline_index + 1 :]
            line = raw_line[:-1] if raw_line.endswith("\r") else raw_line

            if line == "":
                frame = self._dispatch()
                if frame is not None:
                    frames.append(frame)
                continue
            if line.startswith(":"):
                continue  # comment / heartbeat — not a field, no-op

            colon_index = line.find(":")
            if colon_index == -1:
                field, value = line, ""
            else:
                field, value = line[:colon_index], line[colon_index + 1 :]
            if value.startswith(" "):
                value = value[1:]

            if field == "event":
                self._event_name = value or DEFAULT_EVENT_NAME
                self._saw_any_field = True
            elif field == "data":
                self._data_lines.append(value)
                self._saw_any_field = True
            # id:/retry: accepted-and-ignored by design — see module doc comment.

        if len(self._buffer.encode("utf-8")) > self._max_line_bytes:
            cap = self._max_line_bytes
            self._reset()
            raise SseLineTooLongError(
                f"envpit: SSE line exceeded {cap} bytes without a terminator"
            )
        return frames

    def _dispatch(self) -> SseFrame | None:
        if not self._saw_any_field:
            return None  # a stray/consecutive blank line — nothing to dispatch
        frame = SseFrame(event=self._event_name, data="\n".join(self._data_lines))
        self._event_name = DEFAULT_EVENT_NAME
        self._data_lines = []
        self._saw_any_field = False
        return frame

    def _reset(self) -> None:
        self._buffer = ""
        self._event_name = DEFAULT_EVENT_NAME
        self._data_lines = []
        self._saw_any_field = False
