package com.envpit;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal, hand-rolled, dependency-free JSON parser — Sara's R5 risk flag
 * (SPEC-envpit-0t2z-3-1a-architecture.md §2.3: "a ~150-line internal minimal JSON parser... Sara
 * flagged this as risk R5, a hand-rolled parser is real attack surface, review it hard yourself
 * as you write it, apply Sentinel's adversarial depth/size caps rigorously — this is the
 * highest-risk single piece of the whole Java SDK"). Read this file's every branch as adversarial
 * input surface: it parses bytes that came from the network, from a server this SDK does not
 * control (or, under a TLS-bypass MITM, an active attacker).
 *
 * <p><b>Threat model / design invariants (Sentinel THREATMODEL-envpit-0t2z-3.md F2, AC-SEC-SDK3-2,
 * CONFORMANCE.md INV-SDK-13-proposed):</b>
 * <ul>
 *   <li><b>Depth-bounded by construction, never by catching a JVM {@link Error}.</b> This is a
 *       recursive-descent parser (objects/arrays recurse into {@link #parseValue}), which makes it
 *       the one Java-specific "recursion-vulnerable by construction" parser shape Sentinel's F2
 *       specifically calls out (unlike Node's V8/Python's C-accelerated {@code json} module, which
 *       are non-recursive). The mitigation is an EXPLICIT depth counter checked BEFORE every
 *       recursive descent into a container ({@link #parseObject}/{@link #parseArray}), not a
 *       {@code try { ... } catch (StackOverflowError e)} — this SDK never catches {@link Error}
 *       anywhere (the "Java over-catch trap" Sara flagged for the listener-safety wrapper applies
 *       here too, arguably more so: swallowing a real {@code StackOverflowError} would hide a bug
 *       in THIS cap, not just over-catch a user callback). {@link #MAX_DEPTH} = 32 (Sentinel's
 *       recommended number — the two real payload shapes, a flat config snapshot and a tiny push
 *       payload, are flat by contract, so 32 levels of headroom is generous, not tight) bounds the
 *       actual JVM call-stack depth to at most ~2×32 frames regardless of how deep a malicious
 *       input CLAIMS to be nested — a 200,000-deep depth-bomb (test-vectors/adversarial-payloads.json
 *       "json-depth-bomb-nested-arrays-is-memory-safe") is rejected the moment parsing reaches
 *       depth 33, in microseconds, never approaching a real stack limit.
 *   <li><b>Size is NOT this parser's job — it's the caller's</b> (Transport.java reads the HTTP
 *       response body through a byte-capped reader BEFORE any of this file ever sees the bytes;
 *       RealtimeTransport/SseFrameParser caps SSE line length the same way). This file only
 *       receives already-size-bounded strings.
 *   <li><b>Every malformed-input branch below throws {@link JsonParseException}, never lets a raw
 *       {@link RuntimeException} (e.g. {@link StringIndexOutOfBoundsException} from an
 *       unchecked {@code charAt}) escape.</b> Every character access in this file is bounds-checked
 *       via {@link #atEnd()}/{@link #peek()} before use — verified line-by-line, not assumed.
 *   <li><b>Trailing garbage after the top-level value is rejected</b>
 *       ("trailing-garbage-after-valid-json-is-rejected" vector) — {@link #parse(String)} requires
 *       the remainder of the input to be whitespace-only after the top-level value.
 * </ul>
 */
final class Json {

    /**
     * Maximum container-nesting depth (Sentinel THREATMODEL-envpit-0t2z-3.md F2 recommendation —
     * the two shipped payload shapes are flat by contract, so this is deliberately generous
     * headroom, not a tight fit). Exceeding it throws {@link JsonParseException}; it is never
     * reachable via JVM stack exhaustion because it is checked before every recursive descent.
     */
    static final int MAX_DEPTH = 32;

    private Json() {
    }

    /**
     * Parses {@code input} as a single JSON value (object, array, string, number, boolean, or
     * {@code null}), returning the Java shape: {@code Map<String,Object>} for objects (insertion
     * order preserved, {@link LinkedHashMap}), {@code List<Object>} for arrays, {@link String},
     * {@link Double} for every number (matching JS's single numeric type — this SDK never needs
     * integer precision from the wire; every numeric config VALUE is itself a JSON string, per the
     * config-snapshot contract), {@link Boolean}, or {@code null}.
     */
    static Object parse(String input) throws JsonParseException {
        Parser p = new Parser(input);
        p.skipWhitespace();
        Object value = p.parseValue(0);
        p.skipWhitespace();
        if (!p.atEnd()) {
            throw new JsonParseException("trailing garbage after JSON value at position " + p.pos);
        }
        return value;
    }

    private static final class Parser {
        private final String s;
        private final int len;
        private int pos;

        Parser(String s) {
            this.s = s;
            this.len = s.length();
            this.pos = 0;
        }

        boolean atEnd() {
            return pos >= len;
        }

        char peek() throws JsonParseException {
            if (pos >= len) {
                throw new JsonParseException("unexpected end of input at position " + pos);
            }
            return s.charAt(pos);
        }

        void expect(char c) throws JsonParseException {
            if (peek() != c) {
                throw new JsonParseException("expected '" + c + "' at position " + pos);
            }
            pos++;
        }

        void skipWhitespace() {
            while (pos < len) {
                char c = s.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else {
                    break;
                }
            }
        }

        Object parseValue(int depth) throws JsonParseException {
            skipWhitespace();
            char c = peek();
            return switch (c) {
                case '{' -> parseObject(depth);
                case '[' -> parseArray(depth);
                case '"' -> parseString();
                case 't' -> parseLiteral("true", Boolean.TRUE);
                case 'f' -> parseLiteral("false", Boolean.FALSE);
                case 'n' -> parseLiteral("null", null);
                default -> {
                    if (c == '-' || isDigit(c)) {
                        yield parseNumber();
                    }
                    throw new JsonParseException("unexpected character '" + c + "' at position " + pos);
                }
            };
        }

        Map<String, Object> parseObject(int depth) throws JsonParseException {
            if (depth >= MAX_DEPTH) {
                throw new JsonParseException("maximum JSON nesting depth (" + MAX_DEPTH + ") exceeded");
            }
            expect('{');
            Map<String, Object> result = new LinkedHashMap<>();
            skipWhitespace();
            if (peek() == '}') {
                pos++;
                return result;
            }
            while (true) {
                skipWhitespace();
                if (peek() != '"') {
                    throw new JsonParseException("expected a string object key at position " + pos);
                }
                String key = parseString();
                skipWhitespace();
                expect(':');
                Object value = parseValue(depth + 1);
                result.put(key, value);
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == '}') {
                    pos++;
                    break;
                }
                throw new JsonParseException("expected ',' or '}' at position " + pos);
            }
            return result;
        }

        List<Object> parseArray(int depth) throws JsonParseException {
            if (depth >= MAX_DEPTH) {
                throw new JsonParseException("maximum JSON nesting depth (" + MAX_DEPTH + ") exceeded");
            }
            expect('[');
            List<Object> result = new ArrayList<>();
            skipWhitespace();
            if (peek() == ']') {
                pos++;
                return result;
            }
            while (true) {
                Object value = parseValue(depth + 1);
                result.add(value);
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == ']') {
                    pos++;
                    break;
                }
                throw new JsonParseException("expected ',' or ']' at position " + pos);
            }
            return result;
        }

        String parseString() throws JsonParseException {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (pos >= len) {
                    throw new JsonParseException("unterminated string literal");
                }
                char c = s.charAt(pos++);
                if (c == '"') {
                    break;
                }
                if (c == '\\') {
                    sb.append(parseEscape());
                } else if (c < 0x20) {
                    throw new JsonParseException("unescaped control character in string literal at position " + (pos - 1));
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }

        char parseEscape() throws JsonParseException {
            if (pos >= len) {
                throw new JsonParseException("unterminated escape sequence");
            }
            char esc = s.charAt(pos++);
            return switch (esc) {
                case '"' -> '"';
                case '\\' -> '\\';
                case '/' -> '/';
                case 'b' -> '\b';
                case 'f' -> '\f';
                case 'n' -> '\n';
                case 'r' -> '\r';
                case 't' -> '\t';
                case 'u' -> parseUnicodeEscape();
                default -> throw new JsonParseException("invalid escape character '\\" + esc + "' at position " + (pos - 1));
            };
        }

        char parseUnicodeEscape() throws JsonParseException {
            if (pos + 4 > len) {
                throw new JsonParseException("truncated \\u escape at position " + pos);
            }
            String hex = s.substring(pos, pos + 4);
            for (int i = 0; i < 4; i++) {
                if (Character.digit(hex.charAt(i), 16) < 0) {
                    throw new JsonParseException("invalid \\u escape '" + hex + "' at position " + pos);
                }
            }
            int codeUnit = Integer.parseInt(hex, 16);
            pos += 4;
            return (char) codeUnit;
        }

        Double parseNumber() throws JsonParseException {
            int start = pos;
            if (pos < len && s.charAt(pos) == '-') {
                pos++;
            }
            if (pos >= len || !isDigit(s.charAt(pos))) {
                throw new JsonParseException("invalid number at position " + start);
            }
            if (s.charAt(pos) == '0') {
                pos++;
            } else {
                while (pos < len && isDigit(s.charAt(pos))) {
                    pos++;
                }
            }
            if (pos < len && s.charAt(pos) == '.') {
                pos++;
                if (pos >= len || !isDigit(s.charAt(pos))) {
                    throw new JsonParseException("invalid number fraction at position " + pos);
                }
                while (pos < len && isDigit(s.charAt(pos))) {
                    pos++;
                }
            }
            if (pos < len && (s.charAt(pos) == 'e' || s.charAt(pos) == 'E')) {
                pos++;
                if (pos < len && (s.charAt(pos) == '+' || s.charAt(pos) == '-')) {
                    pos++;
                }
                if (pos >= len || !isDigit(s.charAt(pos))) {
                    throw new JsonParseException("invalid number exponent at position " + pos);
                }
                while (pos < len && isDigit(s.charAt(pos))) {
                    pos++;
                }
            }
            String numStr = s.substring(start, pos);
            try {
                return Double.parseDouble(numStr);
            } catch (NumberFormatException e) {
                throw new JsonParseException("invalid number literal '" + numStr + "'");
            }
        }

        Object parseLiteral(String literal, Object value) throws JsonParseException {
            if (pos + literal.length() > len || !s.regionMatches(pos, literal, 0, literal.length())) {
                throw new JsonParseException("invalid literal at position " + pos);
            }
            pos += literal.length();
            return value;
        }

        static boolean isDigit(char c) {
            return c >= '0' && c <= '9';
        }
    }
}
