package com.envpit;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * Manages exactly one logical realtime (SSE) connection to {@code GET .../api/v1/config/events},
 * with transparent reconnection. {@link EnvpitClient} owns deciding WHAT to do with a change
 * signal or a mode change (the callbacks passed to the constructor); this type owns the
 * connection lifecycle only — Java port of the shipped Node/Python/Go {@code RealtimeTransport}.
 *
 * <p><b>Threading (deliberate, documented deviation from a literal "one thread total" reading of
 * Sara's spec text — see the class-level report filed alongside this SDK):</b> the blocking SSE
 * socket read loop runs on its OWN dedicated daemon thread (unavoidable — {@code
 * java.net.http.HttpClient}'s synchronous body-reading API blocks the calling thread for the
 * entire connection lifetime, and sharing that thread with periodic poll ticks is structurally
 * impossible). This thread NEVER invokes a user-registered {@code ChangeListener}/{@code
 * ConnectionListener}/{@code ErrorListener} directly — every callback that would reach user code
 * ({@link #onModeChange}) is submitted to the client's single dispatch {@link
 * ScheduledExecutorService} via {@link ScheduledExecutorService#execute}, so listener invocation
 * itself is still confined to exactly one dedicated background thread, matching the mandate
 * literally for the part of it that matters to callers (no listener is ever invoked
 * concurrently from two different threads, and never on the caller's own thread). {@link
 * #onChangeSignal} similarly only ever triggers a refresh request funneled through that same
 * single executor (see {@code EnvpitClient.requestRefresh}) — it never fetches or dispatches
 * directly from this thread either.
 *
 * <p><b>bd:envpit-tkvz-class fix, baked in from the start (carried-forward lesson from Go):</b>
 * the degraded-mode 5-minute warn task is a {@link ScheduledFuture} obtained from the SAME
 * dispatch executor the client uses (never a private, ad-hoc {@link java.util.Timer}). {@link
 * #run()}'s {@code finally} block ({@link #stopWarnTimer()}) covers EVERY exit path from the read
 * loop — success, an explicit {@link #requestStop()}, or thread interruption — not just the one
 * path ({@link #onSuccess()}) that stops it on recovery. This is deliberately the SAME shape as
 * the fix Go needed after shipping without it (bd:envpit-tkvz): a scheduled task that is only
 * cancelled on ONE of several exit paths is exactly the footgun. Layer 2 of defense: {@link
 * EnvpitClient#close()} additionally shuts down the whole shared executor
 * ({@code shutdown()}/{@code awaitTermination()}/{@code shutdownNow()}), so even a hypothetical
 * future exit path that forgot to call {@link #stopWarnTimer()} still cannot let the warn task
 * fire post-close.
 */
final class RealtimeTransport {

    private static final String CONFIG_EVENTS_PATH = "/api/v1/config/events";
    private static final String CONFIG_CHANGED_EVENT = "config-changed";
    private static final String RECONNECT_EVENT = "reconnect";

    private static final Duration DEFAULT_QUICK_RECONNECT_DELAY = Duration.ofSeconds(1);
    private static final Duration DEFAULT_DEGRADED_RECONNECT_INTERVAL = Duration.ofSeconds(10);
    private static final Duration DEFAULT_DEGRADED_RECONNECT_JITTER = Duration.ofSeconds(2);
    private static final Duration DEFAULT_DEGRADED_WARN_THRESHOLD = Duration.ofMinutes(5);
    private static final int SSE_READ_CHUNK_BYTES = 4096;

    private final String host;
    private final String apiKey;
    private final HttpClient httpClient;
    private final Duration pollInterval;
    private final int maxLineBytes;
    private final Consumer<String> onChangeSignal;
    private final ConnectionModeChangeHandler onModeChange;
    private final BiConsumer<String, String> onLog; // (level, message)
    private final ScheduledExecutorService scheduledExecutor;

    private final Duration quickReconnectDelay;
    private final Duration degradedReconnectInterval;
    private final Duration degradedReconnectJitter;
    private final Duration degradedWarnThreshold;

    private final Object lock = new Object();
    private ConnectionMode mode = ConnectionMode.POLLING;
    private Instant degradedSince;
    private boolean warnedThisEpisode;
    private boolean quickRetryUsedForEpisode;
    private boolean expectingServerReconnect;
    private ScheduledFuture<?> warnTask;
    private Duration nextDelay = Duration.ZERO;

    private volatile boolean stopRequested = false;

    RealtimeTransport(String host, String apiKey, HttpClient httpClient, Duration pollInterval,
                       int maxLineBytes, Consumer<String> onChangeSignal, ConnectionModeChangeHandler onModeChange,
                       BiConsumer<String, String> onLog, ScheduledExecutorService scheduledExecutor) {
        this(host, apiKey, httpClient, pollInterval, maxLineBytes, onChangeSignal, onModeChange, onLog,
                scheduledExecutor, DEFAULT_QUICK_RECONNECT_DELAY, DEFAULT_DEGRADED_RECONNECT_INTERVAL,
                DEFAULT_DEGRADED_RECONNECT_JITTER, DEFAULT_DEGRADED_WARN_THRESHOLD);
    }

    /** Test-only constructor with timing overrides — package-private, never used by production code. */
    RealtimeTransport(String host, String apiKey, HttpClient httpClient, Duration pollInterval,
                       int maxLineBytes, Consumer<String> onChangeSignal, ConnectionModeChangeHandler onModeChange,
                       BiConsumer<String, String> onLog, ScheduledExecutorService scheduledExecutor,
                       Duration quickReconnectDelay, Duration degradedReconnectInterval,
                       Duration degradedReconnectJitter, Duration degradedWarnThreshold) {
        this.host = host;
        this.apiKey = apiKey;
        this.httpClient = httpClient;
        this.pollInterval = pollInterval;
        this.maxLineBytes = maxLineBytes;
        this.onChangeSignal = onChangeSignal;
        this.onModeChange = onModeChange;
        this.onLog = onLog;
        this.scheduledExecutor = scheduledExecutor;
        this.quickReconnectDelay = quickReconnectDelay;
        this.degradedReconnectInterval = degradedReconnectInterval;
        this.degradedReconnectJitter = degradedReconnectJitter;
        this.degradedWarnThreshold = degradedWarnThreshold;
    }

    /** AC-SEC-SDK3-1: this type holds the API key — redact it from every default formatter. */
    @Override
    public String toString() {
        return "envpit.RealtimeTransport(host=" + quote(host) + ", apiKey=<redacted>)";
    }

    private static String quote(String s) {
        return "\"" + s + "\"";
    }

    void requestStop() {
        stopRequested = true;
    }

    /**
     * Drives the connect/pump/reconnect loop for the transport's entire lifetime, until {@link
     * #requestStop()} is called or this thread is interrupted. Intended to run on its own
     * dedicated daemon thread (see class doc comment).
     */
    void run() {
        try {
            while (!stopRequested && !Thread.currentThread().isInterrupted()) {
                connectOnce();
                if (stopRequested || Thread.currentThread().isInterrupted()) {
                    return;
                }
                Duration delay = consumeDelay();
                try {
                    Thread.sleep(delay.toMillis());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        } finally {
            // bd:envpit-tkvz-class fix — see class doc comment. Covers every exit above.
            stopWarnTimer();
        }
    }

    private void connectOnce() {
        String url = host + CONFIG_EVENTS_PATH;
        HttpRequest request;
        try {
            request = HttpRequest.newBuilder(URI.create(url))
                    .header("X-Api-Key", apiKey)
                    .header("Accept", "text/event-stream")
                    .GET()
                    .build();
        } catch (RuntimeException e) {
            if (!stopRequested) {
                onFailure();
            }
            return;
        }

        HttpResponse<InputStream> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            if (!stopRequested) {
                onFailure();
            }
            return;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        }

        if (stopRequested) {
            drainQuietly(response.body());
            return;
        }
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            drainQuietly(response.body());
            onFailure();
            return;
        }

        onSuccess();
        pump(response.body());

        if (stopRequested) {
            return;
        }
        onFailure();
    }

    /**
     * Reads raw bytes and incrementally decodes UTF-8 across chunk boundaries (a {@link
     * CharsetDecoder} instance is reused for the WHOLE connection, so a multi-byte character
     * split across two socket reads decodes correctly — unlike Go, Java strings are UTF-16, not
     * raw bytes, so this SDK needs the same incremental-decode discipline Node/Python's own SSE
     * readers need; a naive per-chunk {@code new String(bytes, UTF_8)} would corrupt any
     * multi-byte character that happened to straddle a chunk boundary).
     */
    private void pump(InputStream body) {
        SseFrameParser parser = new SseFrameParser(maxLineBytes);
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPLACE)
                .onUnmappableCharacter(CodingErrorAction.REPLACE);
        byte[] buf = new byte[SSE_READ_CHUNK_BYTES];
        try (body) {
            int n;
            while (!stopRequested && (n = body.read(buf)) != -1) {
                String chunk = decodeChunk(decoder, buf, n);
                List<SseFrame> frames;
                try {
                    frames = parser.push(chunk);
                } catch (SseLineTooLongException e) {
                    onLog.accept("warn", e.getMessage());
                    return; // treated exactly like any other stream failure — caller reconnects via backoff
                }
                for (SseFrame frame : frames) {
                    handleFrame(frame);
                    if (stopRequested) {
                        return;
                    }
                }
            }
        } catch (IOException e) {
            // a read/decode error mid-stream is just a disconnect — same as every other SDK's pump loop
        }
    }

    private static String decodeChunk(CharsetDecoder decoder, byte[] buf, int len) {
        ByteBuffer in = ByteBuffer.wrap(buf, 0, len);
        CharBuffer out = CharBuffer.allocate(len + 8);
        decoder.decode(in, out, false); // endOfInput=false: buffers a trailing partial multi-byte sequence for the next call
        out.flip();
        return out.toString();
    }

    private static void drainQuietly(InputStream body) {
        try (body) {
            body.readAllBytes();
        } catch (IOException ignored) {
            // best-effort
        }
    }

    // Package-private (not private) so push-payloads.json vector tests can drive frame routing
    // directly, matching Go's identical same-package test-access pattern.
    void handleFrame(SseFrame frame) {
        switch (frame.event()) {
            case CONFIG_CHANGED_EVENT -> {
                String etag = parseEtag(frame.data());
                if (etag != null) {
                    onChangeSignal.accept(etag);
                }
            }
            case RECONNECT_EVENT -> {
                // The server is about to close this stream deliberately (rotation/shutdown/
                // revocation sweep) — remember that, so the next successful connect logs the
                // quieter "reconnected (server rotation)" line instead of a generic one.
                synchronized (lock) {
                    expectingServerReconnect = true;
                }
            }
            default -> {
                // Unknown event name (e.g. a future flags-changed frame) — ignored by design.
            }
        }
    }

    /**
     * Extracts a {@code config-changed} push payload's etag field. Any shape that isn't "a JSON
     * object with a non-empty string etag field" is silently ignored — malformed/partial push
     * payloads must never crash the transport or trigger a bogus refetch
     * (test-vectors/push-payloads.json).
     */
    static String parseEtag(String data) {
        Object parsed;
        try {
            parsed = Json.parse(data);
        } catch (JsonParseException e) {
            return null;
        }
        if (!(parsed instanceof java.util.Map<?, ?> map)) {
            return null;
        }
        Object etagRaw = map.get("etag");
        if (!(etagRaw instanceof String etag) || etag.isEmpty()) {
            return null;
        }
        return etag;
    }

    private void onSuccess() {
        boolean modeChanged;
        String logLevel;
        String logMessage;
        Instant since = Instant.now();

        synchronized (lock) {
            quickRetryUsedForEpisode = false;
            boolean wasServerReconnect = expectingServerReconnect;
            expectingServerReconnect = false;
            boolean wasDegraded = degradedSince != null;
            degradedSince = null;
            warnedThisEpisode = false;
            stopWarnTimerLocked();

            modeChanged = mode != ConnectionMode.REALTIME;
            if (modeChanged) {
                mode = ConnectionMode.REALTIME;
            }

            if (wasDegraded) {
                logLevel = "info";
                logMessage = "envpit: realtime channel restored";
            } else if (wasServerReconnect) {
                logLevel = "debug";
                logMessage = "envpit: realtime channel reconnected (server rotation)";
            } else {
                logLevel = "debug";
                logMessage = "envpit: realtime config channel connected";
            }
        }

        onLog.accept(logLevel, logMessage);
        if (modeChanged) {
            onModeChange.handle(ConnectionMode.REALTIME, ConnectionReason.CONNECTED, since);
        }
    }

    private void onFailure() {
        synchronized (lock) {
            // One silent, immediate retry per episode before announcing anything.
            if (!quickRetryUsedForEpisode && degradedSince == null) {
                quickRetryUsedForEpisode = true;
                nextDelay = quickReconnectDelay;
                return;
            }
        }
        declareDegraded(ConnectionReason.NETWORK);
        scheduleDegradedRetry();
    }

    private void declareDegraded(ConnectionReason reason) {
        Instant since;
        boolean modeChanged;
        int pollSec;
        synchronized (lock) {
            if (degradedSince != null) {
                return; // already announced this episode — stay quiet
            }
            since = Instant.now();
            degradedSince = since;
            modeChanged = mode != ConnectionMode.POLLING;
            mode = ConnectionMode.POLLING;
            pollSec = pollSeconds(pollInterval);
        }

        String message = String.format(Locale.ROOT,
                "envpit: realtime channel unavailable — falling back to polling every %ds; config still refreshes, max staleness %ds",
                pollSec, pollSec);
        onLog.accept("info", message);
        if (modeChanged) {
            onModeChange.handle(ConnectionMode.POLLING, reason, since);
        }
        scheduleWarnTimer();
    }

    private void scheduleWarnTimer() {
        synchronized (lock) {
            stopWarnTimerLocked();
            Duration threshold = degradedWarnThreshold;
            warnTask = scheduledExecutor.schedule(
                    () -> onWarnTimerFire(threshold), threshold.toMillis(), TimeUnit.MILLISECONDS);
        }
    }

    private void onWarnTimerFire(Duration threshold) {
        int pollSec;
        synchronized (lock) {
            if (degradedSince == null || warnedThisEpisode) {
                return;
            }
            warnedThisEpisode = true;
            pollSec = pollSeconds(pollInterval);
        }
        long minutes = Math.max(1, threshold.toMinutes());
        onLog.accept("warn", String.format(Locale.ROOT,
                "envpit: realtime channel still unavailable after %d min; continuing to poll every %ds",
                minutes, pollSec));
    }

    private void stopWarnTimerLocked() {
        if (warnTask != null) {
            warnTask.cancel(false);
            warnTask = null;
        }
    }

    /** Lock-acquiring wrapper for callers (e.g. {@link #run()}'s finally block) not already holding {@link #lock}. */
    void stopWarnTimer() {
        synchronized (lock) {
            stopWarnTimerLocked();
        }
    }

    private void scheduleDegradedRetry() {
        Duration jitter = Duration.ZERO;
        if (degradedReconnectJitter.compareTo(Duration.ZERO) > 0) {
            long jitterMillis = ThreadLocalRandom.current().nextLong(degradedReconnectJitter.toMillis() + 1);
            jitter = Duration.ofMillis(jitterMillis);
        }
        synchronized (lock) {
            nextDelay = degradedReconnectInterval.plus(jitter);
        }
    }

    private Duration consumeDelay() {
        synchronized (lock) {
            Duration d = nextDelay;
            nextDelay = Duration.ZERO;
            return d;
        }
    }

    private static int pollSeconds(Duration d) {
        long sec = Math.round(d.toMillis() / 1000.0);
        return (int) Math.max(1, sec);
    }
}
