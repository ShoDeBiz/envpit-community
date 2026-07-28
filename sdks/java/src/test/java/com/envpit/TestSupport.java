package com.envpit;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * Shared test-only utilities: test-vectors/ loader (dogfoods this SDK's own {@link Json} parser —
 * matching the "own package, own test infra" convention Go's {@code testutil_test.go} /
 * Python's {@code tests/_vectors.py} use), a real local HTTP server harness (java.net.http's
 * {@link HttpClient} is a final class with no {@code RoundTripper}-shaped seam the way Go's {@code
 * http.Client.Transport} is, so — unlike Go/Python/Node's fake-transport-object tests — most HTTP-
 * shaped tests in this suite run against a REAL {@code com.sun.net.httpserver.HttpServer}, part of
 * the JDK itself, zero extra test dependency), and a capturing {@link EnvpitLogger}.
 */
final class TestSupport {

    private TestSupport() {
    }

    // ---- test-vectors loader --------------------------------------------------------------

    /**
     * Resolves envpit-community/test-vectors/ from THIS file's own compiled location is not
     * reliable (class files move); instead walk up from the current working directory (Maven
     * always runs with cwd = the module dir, sdks/java) three levels to the repo root — matching
     * Go's {@code vectorsRoot()}/Python's {@code _vectors.py} "up N dirs to repo root" approach,
     * adapted for Maven's stable cwd contract instead of Go's per-file {@code runtime.Caller}.
     */
    static Path vectorsRoot() {
        Path cwd = Path.of("").toAbsolutePath(); // .../envpit-community/sdks/java
        return cwd.resolve("../../test-vectors").normalize();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> loadVectorFile(String name) {
        Path path = vectorsRoot().resolve(name);
        String content;
        try {
            content = Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new AssertionError("failed to read test-vectors/" + name + " at " + path, e);
        }
        try {
            Object parsed = Json.parse(content);
            if (!(parsed instanceof Map)) {
                throw new AssertionError("test-vectors/" + name + " root is not a JSON object");
            }
            return (Map<String, Object>) parsed;
        } catch (JsonParseException e) {
            throw new AssertionError("failed to parse test-vectors/" + name + ": " + e.getMessage(), e);
        }
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> cases(Map<String, Object> doc) {
        Object raw = doc.get("cases");
        List<Object> list = (List<Object>) raw;
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object o : list) {
            result.add((Map<String, Object>) o);
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    static Map<String, String> asStringMap(Object raw) {
        Map<String, Object> map = (Map<String, Object>) raw;
        Map<String, String> result = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, Object> e : map.entrySet()) {
            result.put(e.getKey(), e.getValue() == null ? null : String.valueOf(e.getValue()));
        }
        return result;
    }

    // ---- real local HTTP server harness ---------------------------------------------------

    /** A running local HTTP server whose /api/v1/config (and optionally /api/v1/config/events) handler is swappable per test. */
    static final class TestServer implements AutoCloseable {
        final HttpServer server;
        final String baseUrl;
        volatile Function<HttpExchange, Void> configHandler;
        volatile Function<HttpExchange, Void> eventsHandler;

        private TestServer(HttpServer server) {
            this.server = server;
            this.baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        }

        static TestServer start() {
            try {
                HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                TestServer ts = new TestServer(s);
                s.createContext("/api/v1/config", ex -> {
                    Function<HttpExchange, Void> h = ts.configHandler;
                    if (h == null) {
                        respond(ex, 500, "no configHandler set", null);
                        return;
                    }
                    h.apply(ex);
                });
                s.createContext("/api/v1/config/events", ex -> {
                    Function<HttpExchange, Void> h = ts.eventsHandler;
                    if (h == null) {
                        respond(ex, 500, "no eventsHandler set", null);
                        return;
                    }
                    h.apply(ex);
                });
                s.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
                    Thread t = new Thread(r, "test-http-server");
                    t.setDaemon(true);
                    return t;
                }));
                s.start();
                return ts;
            } catch (IOException e) {
                throw new AssertionError("failed to start local test HTTP server", e);
            }
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }

    static void respond(HttpExchange ex, int status, String body, String etag) {
        try {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            if (etag != null) {
                ex.getResponseHeaders().set("Etag", etag);
            }
            ex.sendResponseHeaders(status, bytes.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(bytes);
            }
        } catch (IOException ignored) {
            // best-effort — a test asserting a connection failure will have already closed things
        }
    }

    /** A config handler that serves the same fixed (status, body) response to every request. */
    static Function<HttpExchange, Void> fixedResponse(int status, String body) {
        return ex -> {
            respond(ex, status, body, null);
            return null;
        };
    }

    /** A config handler that hangs until the client's own request timeout fires. */
    static Function<HttpExchange, Void> hangForever() {
        return ex -> {
            try {
                Thread.sleep(Long.MAX_VALUE);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return null;
        };
    }

    /** A config handler that serves each body in order, one per call — fails loudly once exhausted. */
    static Function<HttpExchange, Void> queue(String... bodies) {
        AtomicInteger i = new AtomicInteger(0);
        List<String> list = List.of(bodies);
        return ex -> {
            int idx = i.getAndIncrement();
            if (idx >= list.size()) {
                respond(ex, 500, "{}", null);
                return null;
            }
            respond(ex, 200, list.get(idx), null);
            return null;
        };
    }

    static HttpClient testHttpClient() {
        return HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    }

    // ---- loaded-client helper --------------------------------------------------------------

    /** Builds a client (poll disabled — INV-SDK-8) loaded from a single canned snapshot body via a real local server. */
    static EnvpitClient newLoadedClient(TestServer server, String snapshotJson) {
        server.configHandler = fixedResponse(200, snapshotJson);
        return EnvpitClient.builder()
                .apiKey("epk_test")
                .host(server.baseUrl)
                .pollInterval(Duration.ZERO)
                .httpClient(testHttpClient())
                .logger(null)
                .load();
    }

    // ---- capturing logger -------------------------------------------------------------------

    static final class CapturingLogger implements EnvpitLogger {
        final List<String> debugs = new CopyOnWriteArrayList<>();
        final List<String> infos = new CopyOnWriteArrayList<>();
        final List<String> warns = new CopyOnWriteArrayList<>();
        final List<String> errors = new CopyOnWriteArrayList<>();

        @Override
        public void debug(String message) {
            debugs.add(message);
        }

        @Override
        public void info(String message) {
            infos.add(message);
        }

        @Override
        public void warn(String message) {
            warns.add(message);
        }

        @Override
        public void error(String message) {
            errors.add(message);
        }

        String lastWarn() {
            return warns.isEmpty() ? null : warns.get(warns.size() - 1);
        }
    }

    // ---- tiny test-only JSON encoder (fixtures only — flat string maps) ---------------------
    //
    // bd:envpit-durd: the wire shape is now the ENVELOPE, {values, secretKeys}, not a bare map
    // (test-vectors/resolve-body.json) — every canned response this suite hands to a real local
    // TestServer must be an envelope or the strict Transport.fetchConfig parser rejects it as a
    // legacy bare map. `toJson` below wraps with an empty secretKeys list (the overwhelming
    // majority of this suite's fixtures don't care about secret labelling at all); tests that DO
    // care call `toEnvelopeJson` directly with an explicit secretKeys set.

    /** Common case: a values-only fixture, no secrets. */
    static String toJson(Map<String, String> values) {
        return toEnvelopeJson(values, java.util.Set.of());
    }

    /** The full post-bd:envpit-durd envelope, with an explicit secretKeys set. */
    static String toEnvelopeJson(Map<String, String> values, java.util.Collection<String> secretKeys) {
        StringBuilder sb = new StringBuilder("{\"values\":");
        sb.append(valuesJson(values));
        sb.append(",\"secretKeys\":[");
        boolean first = true;
        for (String key : secretKeys) {
            if (!first) {
                sb.append(",");
            }
            first = false;
            sb.append(jsonString(key));
        }
        sb.append("]}");
        return sb.toString();
    }

    private static String valuesJson(Map<String, String> snapshot) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> e : snapshot.entrySet()) {
            if (!first) {
                sb.append(",");
            }
            first = false;
            sb.append(jsonString(e.getKey())).append(":");
            sb.append(e.getValue() == null ? "null" : jsonString(e.getValue()));
        }
        return sb.append("}").toString();
    }

    /**
     * Generic re-encoder for arbitrary already-PARSED JSON structures ({@link Map}/{@link List}/
     * {@link String}/{@link Double}/{@link Boolean}/{@code null} — exactly {@link Json#parse}'s
     * own output shapes) back into literal wire text. Needed because
     * test-vectors/resolve-body.json's {@code body} field is itself parsed JSON (a nested object,
     * not a pre-serialized string like {@code adversarial-payloads.json}'s fixtures are) — this
     * turns it back into text to feed a real {@link TestServer}. Dogfoods this SDK's own {@link
     * Json} parser's output contract, run in reverse.
     */
    @SuppressWarnings("unchecked")
    static String encodeJson(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof String s) {
            return jsonString(s);
        }
        if (value instanceof Boolean b) {
            return b.toString();
        }
        if (value instanceof Number n) {
            double d = n.doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d)) {
                return Long.toString((long) d);
            }
            return Double.toString(d);
        }
        if (value instanceof Map<?, ?> m) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) {
                    sb.append(",");
                }
                first = false;
                sb.append(jsonString(String.valueOf(e.getKey()))).append(":").append(encodeJson(e.getValue()));
            }
            return sb.append("}").toString();
        }
        if (value instanceof List<?> l) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object o : l) {
                if (!first) {
                    sb.append(",");
                }
                first = false;
                sb.append(encodeJson(o));
            }
            return sb.append("]").toString();
        }
        throw new IllegalArgumentException("encodeJson: unsupported type " + value.getClass());
    }

    static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                default -> sb.append(c);
            }
        }
        return sb.append("\"").toString();
    }

    static boolean waitUntil(Duration timeout, java.util.function.BooleanSupplier predicate) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (predicate.getAsBoolean()) {
                return true;
            }
            try {
                Thread.sleep(2);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return predicate.getAsBoolean();
            }
        }
        return predicate.getAsBoolean();
    }
}
