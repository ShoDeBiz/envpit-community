package com.envpit.spring;

import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Own test-only local HTTP server harness — this module is a SEPARATE Maven module/package from
 * {@code com.envpit} (see {@code ../../pom.xml}'s top-of-file comment), so the core module's
 * package-private {@code com.envpit.TestSupport} is not reachable here. Same technique as that
 * class ({@code com.sun.net.httpserver.HttpServer}, part of the JDK itself — zero extra test
 * dependency), deliberately kept minimal: this module only needs a fixed-response {@code
 * /api/v1/config} handler, none of the core module's harness's reconnect/queue/hang scenarios.
 */
final class SpringTestSupport {

    private SpringTestSupport() {
    }

    static final class TestServer implements AutoCloseable {
        final HttpServer server;
        final String baseUrl;

        private TestServer(HttpServer server) {
            this.server = server;
            this.baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        }

        static TestServer serving(String snapshotJson) {
            try {
                HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                s.createContext("/api/v1/config", ex -> {
                    byte[] bytes = snapshotJson.getBytes(StandardCharsets.UTF_8);
                    ex.getResponseHeaders().set("Content-Type", "application/json");
                    ex.sendResponseHeaders(200, bytes.length);
                    try (OutputStream os = ex.getResponseBody()) {
                        os.write(bytes);
                    }
                });
                s.setExecutor(java.util.concurrent.Executors.newCachedThreadPool(r -> {
                    Thread t = new Thread(r, "envpit-spring-test-http-server");
                    t.setDaemon(true);
                    return t;
                }));
                s.start();
                return new TestServer(s);
            } catch (IOException e) {
                throw new AssertionError("failed to start local test HTTP server", e);
            }
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }

    /** Same tiny fixture-only JSON encoder as {@code com.envpit.TestSupport#toJson} (flat string maps only). */
    static String toJson(Map<String, String> snapshot) {
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

    private static String jsonString(String s) {
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
}
