package com.envpit;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Consumes {@code test-vectors/adversarial-payloads.json}'s 8 cases (Sentinel AC-SEC-SDK3-2,
 * CONFORMANCE.md INV-SDK-13-proposed) — the last of the 8 shared vector families, and the one with
 * the most direct coverage of {@link Json}, this SDK's highest-risk hand-rolled code (Sara R5).
 *
 * <p><b>Real-local-server methodology (see {@link TestSupport}'s own class doc comment for the
 * full rationale):</b> {@code java.net.http.HttpClient} has no {@code RoundTripper}/{@code
 * fetchImpl}-shaped fake-transport injection seam, unlike Go/Node/Python. Every body-size-cap and
 * malformed-JSON case below round-trips through a REAL {@code com.sun.net.httpserver.HttpServer}
 * bound to an ephemeral local port (via {@link TestSupport.TestServer}) rather than a mocked
 * response object — this is the structural, documented reason this file's shape differs from the
 * other three languages' equivalent vector-consuming test, not a shortcut.
 */
class VectorsAdversarialPayloadsTest {

    private static Map<String, Object> caseByName(String name) {
        Map<String, Object> doc = TestSupport.loadVectorFile("adversarial-payloads.json");
        for (Map<String, Object> c : TestSupport.cases(doc)) {
            if (name.equals(c.get("name"))) {
                return c;
            }
        }
        throw new AssertionError("adversarial-payloads.json: no case named \"" + name + "\"");
    }

    private static int intField(Map<String, Object> c, String key) {
        return ((Number) c.get(key)).intValue();
    }

    /**
     * {@code payloadRecipe: "envelope-single-key-K-padded-string"} (suiteVersion 1.2.0 — the vector
     * file's own recipe, verbatim: {@code {"values": {"K": pad}, "secretKeys": []}}, {@code pad}
     * repeated {@code 'v'} until the serialized object's total UTF-8 byte length equals {@code
     * payloadBytes}). Prior to bd:envpit-durd this recipe built a BARE {@code {"K": pad}} map,
     * which the vector file's own notes now record as RESOLVED — see {@code
     * adversarial-payloads.json}'s top-level {@code description}/{@code notes} for the full
     * history of why the recipe itself had to change at the shared-vector level, not just be
     * patched around per language.
     */
    private static String buildPaddedJsonBody(int targetBytes) {
        String skeleton = "{\"values\":{\"K\": \"\"},\"secretKeys\":[]}"; // envelope around json.dumps({"K": ""})
        int padLength = targetBytes - skeleton.length();
        return "{\"values\":{\"K\": \"" + "v".repeat(padLength) + "\"},\"secretKeys\":[]}";
    }

    /** {@code lineRecipe: "sse-config-changed-data-padded-no-terminator"} — the file's own recipe, verbatim. */
    private static String buildUnterminatedSseLine(int targetBytes) {
        String prefix = "event: config-changed\ndata: ";
        int padLength = targetBytes - prefix.length();
        return prefix + "x".repeat(padLength);
    }

    // ---- body-size-cap (AC-SEC-SDK3-2(a)) ------------------------------------------------------

    @Test
    @Timeout(30)
    void oversizedResponseBodyExceedsCapIsRejectedNotBufferedForever() throws Exception {
        Map<String, Object> c = caseByName("oversized-response-body-exceeds-cap");
        String body = buildPaddedJsonBody(intField(c, "payloadBytes"));
        assertEquals(intField(c, "payloadBytes"), body.length(), "test's own recipe implementation must match the vector's target size");

        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, body);
            NetworkException e = assertThrows(NetworkException.class,
                    () -> Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(10)));
            assertTrue(e.getMessage().contains((String) c.get("expectedMessageSubstring")),
                    "expected message to contain '" + c.get("expectedMessageSubstring") + "', got: " + e.getMessage());
        }
    }

    @Test
    void responseBodyAtCapBoundaryIsAccepted() throws Exception {
        Map<String, Object> c = caseByName("response-body-at-cap-boundary-is-accepted");
        assertTrue(intField(c, "payloadBytes") <= Transport.DEFAULT_BODY_BYTE_CAP,
                "test precondition: this case's payload must be AT/UNDER the cap");
        String body = buildPaddedJsonBody(intField(c, "payloadBytes"));

        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, body);
            Transport.FetchResult result = Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(10));
            assertTrue(result.values().containsKey("K"));
        }
    }

    // ---- sse-line-size-cap (AC-SEC-SDK3-2(b)) --------------------------------------------------

    @Test
    void oversizedSseLineWithoutTerminatorIsCappedNotBufferedForever() {
        Map<String, Object> c = caseByName("oversized-sse-line-without-terminator-is-capped");
        int cap = intField(c, "recommendedCapBytes");
        String hugeUnterminatedLine = buildUnterminatedSseLine(intField(c, "lineBytes"));

        SseFrameParser parser = new SseFrameParser(cap);
        assertThrows(SseLineTooLongException.class, () -> parser.push(hugeUnterminatedLine));
    }

    @Test
    void sseLineUnderTheCapParsesNormally() throws Exception {
        Map<String, Object> c = caseByName("sse-line-under-the-cap-parses-normally");
        int cap = intField(c, "recommendedCapBytes");
        String event = (String) c.get("event");
        String data = (String) c.get("data");

        SseFrameParser parser = new SseFrameParser(cap);
        List<SseFrame> frames = parser.push("event: " + event + "\ndata: " + data + "\n\n");

        assertEquals(1, frames.size());
        @SuppressWarnings("unchecked")
        Map<String, Object> expectedFrame = (Map<String, Object>) c.get("expectedFrame");
        assertEquals(expectedFrame.get("event"), frames.get(0).event());
        assertEquals(expectedFrame.get("data"), frames.get(0).data());
    }

    // ---- json-depth-bomb — safety property, either outcome (clean parse OR clean reject) is compliant ----

    @Test
    @Timeout(10) // the safety property itself: must never hang, regardless of which outcome it picks
    void jsonDepthBombIsMemorySafeJavaRejectsCleanlyViaItsExplicitDepthCap() throws Exception {
        Map<String, Object> c = caseByName("json-depth-bomb-nested-arrays-is-memory-safe");
        int depth = intField(c, "depth");
        String depthBomb = "[".repeat(depth) + "]".repeat(depth);

        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, depthBomb);
            // Java's hand-rolled parser (Json.java) is recursive-descent — recursion-vulnerable BY
            // CONSTRUCTION, unlike Node's V8/Python's C-accelerated json module (both non-recursive).
            // Json.MAX_DEPTH=32 is the explicit mitigation: this MUST reject cleanly (a
            // JsonParseException mapped to NetworkException), never attempt to recurse anywhere
            // near 200,000 stack frames. Compliant with the vector's "either outcome is safe"
            // wording — Java's own choice is documented here as "clean reject", not "clean parse".
            NetworkException e = assertThrows(NetworkException.class,
                    () -> Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(5)));
            assertTrue(e.getMessage().contains("invalid JSON response"), "got: " + e.getMessage());
        }
    }

    @Test
    void jsonParserOwnDepthCapRejectsAtExactlyTheConfiguredBoundaryNotAtStackExhaustion() {
        // Direct unit-level proof (no HTTP round trip needed) that Json.MAX_DEPTH is what's doing
        // the rejecting, not an accidental StackOverflowError further down.
        String justOverTheCap = "[".repeat(Json.MAX_DEPTH + 1) + "]".repeat(Json.MAX_DEPTH + 1);
        JsonParseException e = assertThrows(JsonParseException.class, () -> Json.parse(justOverTheCap));
        assertTrue(e.getMessage().contains("maximum JSON nesting depth"), "got: " + e.getMessage());

        String exactlyAtTheCap = "[".repeat(Json.MAX_DEPTH) + "]".repeat(Json.MAX_DEPTH);
        // Depth accounting starts at 0 for the top-level value, so MAX_DEPTH levels of nesting
        // (Json.MAX_DEPTH arrays deep) must still parse successfully — only EXCEEDING it rejects.
        try {
            Object parsed = Json.parse(exactlyAtTheCap);
            assertTrue(parsed instanceof List, "expected a successfully parsed nested-array structure at exactly the cap");
        } catch (JsonParseException unexpected) {
            fail("a nesting depth of exactly Json.MAX_DEPTH (" + Json.MAX_DEPTH + ") must still parse; got: " + unexpected.getMessage());
        }
    }

    // ---- malformed-json — NOT gaps; both Node and Python already handle these safely today ----

    @Test
    void unterminatedStringValueIsRejectedSafely() throws Exception {
        assertMalformedJsonCaseIsRejectedAsNetworkException("unterminated-string-value-is-rejected-safely");
    }

    @Test
    void invalidUnicodeEscapeIsRejectedSafely() throws Exception {
        assertMalformedJsonCaseIsRejectedAsNetworkException("invalid-unicode-escape-is-rejected-safely");
    }

    @Test
    void trailingGarbageAfterValidJsonIsRejected() throws Exception {
        assertMalformedJsonCaseIsRejectedAsNetworkException("trailing-garbage-after-valid-json-is-rejected");
    }

    private void assertMalformedJsonCaseIsRejectedAsNetworkException(String caseName) throws Exception {
        Map<String, Object> c = caseByName(caseName);
        String input = (String) c.get("input");

        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, input);
            assertThrows(NetworkException.class,
                    () -> Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(5)));
        }
    }
}
