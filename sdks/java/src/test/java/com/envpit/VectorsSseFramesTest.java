package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.fail;

/** Consumes test-vectors/sse-frames.json. */
class VectorsSseFramesTest {

    @TestFactory
    @SuppressWarnings("unchecked")
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("sse-frames.json");
        return TestSupport.cases(doc).stream().map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> {
            String chunkMode = (String) c.get("chunkMode");
            String input = (String) c.get("input");
            List<Map<String, Object>> expectedFrames = (List<Map<String, Object>>) (List<?>) c.get("expectedFrames");

            SseFrameParser parser = new SseFrameParser(SseFrameParser.DEFAULT_MAX_LINE_BYTES);
            List<SseFrame> frames = new ArrayList<>();

            try {
                switch (chunkMode) {
                    case "char" -> {
                        // "one Unicode code point at a time" — iterate by code point, not UTF-16
                        // char, so a surrogate pair is never split (matches the vector family's
                        // own "worst-case chunk splitting" intent, one level more careful than a
                        // naive charAt loop).
                        int i = 0;
                        while (i < input.length()) {
                            int cp = input.codePointAt(i);
                            String piece = new String(Character.toChars(cp));
                            frames.addAll(parser.push(piece));
                            i += Character.charCount(cp);
                        }
                    }
                    case "whole" -> frames.addAll(parser.push(input));
                    default -> fail("unhandled chunkMode " + chunkMode);
                }
            } catch (SseLineTooLongException e) {
                fail("unexpected SseLineTooLongException: " + e.getMessage());
            }

            assertEquals(expectedFrames.size(), frames.size(), (String) c.get("name"));
            for (int i = 0; i < frames.size(); i++) {
                assertEquals(expectedFrames.get(i).get("event"), frames.get(i).event(), (String) c.get("name") + " frame " + i + " event");
                assertEquals(expectedFrames.get(i).get("data"), frames.get(i).data(), (String) c.get("name") + " frame " + i + " data");
            }
        })).collect(Collectors.toList());
    }
}
