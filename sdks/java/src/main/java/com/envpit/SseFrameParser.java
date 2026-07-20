package com.envpit;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * A minimal server-sent-events frame parser. Feed it chunks of the (already UTF-8-decoded, see
 * {@link RealtimeTransport}) response text via {@link #push(String)} — a chunk may split a frame,
 * or even a single line, at any character boundary, exactly how a streamed HTTP response body
 * arrives. Comment lines (leading {@code ':'}, used by the server for {@code ': heartbeat'}
 * keep-alives) are consumed and produce no frame.
 *
 * <p>Deliberately NOT a general-purpose SSE client — no {@code id:}/{@code retry:} handling, no
 * Last-Event-ID replay (the server doesn't support replay either). Ground truth:
 * {@code sdks/node/src/sse-parser.ts} / {@code sdks/go/envpit/sse_parser.go}.
 *
 * <p><b>AC-SEC-SDK3-2(b):</b> the internal buffer is capped ({@link #maxLineBytes}) so a
 * misbehaving/adversarial server sending an unterminated line cannot grow it without bound.
 * {@link #maxLineBytes} is a Java {@code char} (UTF-16 code unit) count, used as a conservative
 * proxy for a UTF-8 byte cap: for the shared adversarial vector's ASCII padding recipe the two are
 * numerically identical, and for any non-ASCII content a UTF-8-encoded byte count is always
 * &gt;= the UTF-16 char count, so this cap can only trigger EARLIER (more protective), never
 * later, than an exact byte-count cap would.
 */
final class SseFrameParser {

    static final int DEFAULT_MAX_LINE_BYTES = 64 * 1024;
    private static final String DEFAULT_EVENT_NAME = "message";

    private final StringBuilder buffer = new StringBuilder();
    private String eventName = DEFAULT_EVENT_NAME;
    private final List<String> dataLines = new ArrayList<>();
    private boolean sawAnyField = false;
    private final int maxLineBytes;

    SseFrameParser(int maxLineBytes) {
        this.maxLineBytes = maxLineBytes > 0 ? maxLineBytes : DEFAULT_MAX_LINE_BYTES;
    }

    /**
     * Feeds a chunk of already-decoded text; returns any complete frames it produced (zero, one,
     * or many, in order). Throws {@link SseLineTooLongException} if the in-progress line has grown
     * past the cap without a terminator — the internal buffer is reset first, leaving the parser
     * in a clean state for the caller's next decision (reconnect).
     */
    List<SseFrame> push(String chunk) throws SseLineTooLongException {
        buffer.append(chunk);
        List<SseFrame> frames = new ArrayList<>();

        int newlineIdx;
        while ((newlineIdx = indexOfNewline()) != -1) {
            String rawLine = buffer.substring(0, newlineIdx);
            buffer.delete(0, newlineIdx + 1);
            String line = rawLine.endsWith("\r") ? rawLine.substring(0, rawLine.length() - 1) : rawLine;

            if (line.isEmpty()) {
                dispatch().ifPresent(frames::add);
            } else if (line.startsWith(":")) {
                // comment / heartbeat — no-op
            } else {
                String[] fieldValue = splitField(line);
                switch (fieldValue[0]) {
                    case "event" -> {
                        eventName = fieldValue[1].isEmpty() ? DEFAULT_EVENT_NAME : fieldValue[1];
                        sawAnyField = true;
                    }
                    case "data" -> {
                        dataLines.add(fieldValue[1]);
                        sawAnyField = true;
                    }
                    default -> {
                        // id:/retry:/anything else — accepted-and-ignored by design.
                    }
                }
            }
        }

        if (buffer.length() > maxLineBytes) {
            reset();
            throw new SseLineTooLongException(
                    "envpit: SSE line exceeded the maximum byte cap without a terminator");
        }
        return frames;
    }

    private int indexOfNewline() {
        for (int i = 0; i < buffer.length(); i++) {
            if (buffer.charAt(i) == '\n') {
                return i;
            }
        }
        return -1;
    }

    private static String[] splitField(String line) {
        int idx = line.indexOf(':');
        if (idx == -1) {
            return new String[]{line, ""};
        }
        String field = line.substring(0, idx);
        String rest = line.substring(idx + 1);
        String value = rest.startsWith(" ") ? rest.substring(1) : rest;
        return new String[]{field, value};
    }

    private Optional<SseFrame> dispatch() {
        if (!sawAnyField) {
            return Optional.empty(); // a stray/consecutive blank line — nothing to dispatch
        }
        SseFrame frame = new SseFrame(eventName, String.join("\n", dataLines));
        eventName = DEFAULT_EVENT_NAME;
        dataLines.clear();
        sawAnyField = false;
        return Optional.of(frame);
    }

    private void reset() {
        buffer.setLength(0);
        eventName = DEFAULT_EVENT_NAME;
        dataLines.clear();
        sawAnyField = false;
    }
}
