package com.envpit;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Consumes test-vectors/resolve-body.json (bd:envpit-durd, AC-SEC-E11) — the config-resolve 200
 * body's wire shape, {@code {values, secretKeys}}, and every case where a body is JSON but not
 * this envelope (mapped to the SAME {@code NetworkError} class error-mapping.json's
 * {@code invalid-json-body} case uses, per this vector file's own notes). Round-trips every case
 * through a real local HTTP server (see {@link TestSupport}'s own class doc comment for why:
 * {@code java.net.http.HttpClient} has no fake-transport injection seam, unlike Go/Node/Python).
 */
class VectorsResolveBodyTest {

    @TestFactory
    List<DynamicTest> vectors() {
        Map<String, Object> doc = TestSupport.loadVectorFile("resolve-body.json");
        return TestSupport.cases(doc).stream()
                .map(c -> DynamicTest.dynamicTest((String) c.get("name"), () -> runCase(c)))
                .collect(Collectors.toList());
    }

    @SuppressWarnings("unchecked")
    private void runCase(Map<String, Object> c) {
        String name = (String) c.get("name");
        Object body = c.get("body");
        String bodyJson = TestSupport.encodeJson(body);

        try (TestSupport.TestServer server = TestSupport.TestServer.start()) {
            server.configHandler = TestSupport.fixedResponse(200, bodyJson);

            String expectedError = (String) c.get("expectedError");
            if (expectedError != null) {
                EnvpitException ex = assertThrows(EnvpitException.class,
                        () -> Transport.fetchConfig(TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(3)),
                        name);
                String actual = ex.getClass().getSimpleName().replace("Exception", "Error");
                assertEquals(expectedError, actual, name + ": " + ex.getMessage());
                return;
            }

            Map<String, Object> expected = (Map<String, Object>) c.get("expected");
            Map<String, String> expectedValues = TestSupport.asStringMap(expected.get("values"));
            List<String> expectedSecretKeys = (List<String>) (List<?>) expected.get("secretKeys");

            Transport.FetchResult result = Transport.fetchConfig(
                    TestSupport.testHttpClient(), server.baseUrl, "epk_test", Duration.ofSeconds(3));
            assertEquals(expectedValues, result.values(), name);
            assertEquals(Set.copyOf(expectedSecretKeys), result.secretKeys(), name);
        }
    }
}
