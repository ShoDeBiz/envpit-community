package com.envpit;

import java.net.http.HttpClient;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * The SDK's core, instantiated client (Sara SPEC-envpit-0t2z-3-1a-architecture.md §2.3:
 * "the instantiated client is the primitive in every language"; no static singleton — hostile to
 * DI containers). Construct one with {@code EnvpitClient.builder()...load()}.
 *
 * <p><b>{@code load()} is the builder's TERMINAL method — there is deliberately no public {@code
 * build()}</b> (Uma's reconciled DX fix, SPEC-envpit-0t2z-3-1b-ux.md §0.2 item 1: a two-step
 * {@code builder().build()} then {@code .load()} would leave a reachable, half-initialized client
 * object in between — exactly the shape Bella's AC-SDK-05a forbids, "no reachable state where a
 * caller holds a client object that hasn't completed its first fetch"). {@code load()} blocks,
 * performs the environment's config fetch once, and either returns a fully-ready client or throws
 * an {@link EnvpitException} subtype — INV-SDK-1.
 *
 * <p>Implements {@link AutoCloseable} — works naturally with try-with-resources and DI-container
 * lifecycles (e.g. Spring's {@code @Bean(destroyMethod = "close")}).
 *
 * <pre>{@code
 * EnvpitClient envpit = EnvpitClient.builder().load();
 * String dbUrl = envpit.get("DATABASE_URL");
 * }</pre>
 */
public final class EnvpitClient implements AutoCloseable {

    static final String DEFAULT_HOST = "https://envpit.com";
    static final Duration DEFAULT_POLL_INTERVAL = Duration.ofSeconds(60);
    static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(5);

    private static final Pattern INTEGER_PATTERN = Pattern.compile("^-?\\d+$");
    private static final java.util.Set<String> TRUE_VALUES = java.util.Set.of("true", "1", "yes", "on");
    private static final java.util.Set<String> FALSE_VALUES = java.util.Set.of("false", "0", "no", "off");

    final String apiKey; // package-private: INV-SDK-12 tests read this directly
    String host; // package-private, non-final: tests redirect this mid-test (bd:envpit-4dbm live-reset pattern)
    HttpClient httpClient; // package-private, non-final: same reason
    private final Duration pollInterval;
    final Duration timeout; // package-private: Transport calls read this via the client in tests
    private final EnvpitLogger logger;

    volatile CacheState state; // package-private for direct test inspection

    private final ScheduledExecutorService dispatchExecutor; // null when pollInterval <= 0 (RefreshMode.OFF)
    private final ScheduledFuture<?> pollTask;
    final RealtimeTransport realtimeTransport; // package-private: INV-SDK-8 test asserts this is null when off
    private final Thread realtimeThread;

    private final ListenerRegistry<ChangeListener> changeListeners = new ListenerRegistry<>();
    private final ListenerRegistry<ConnectionListener> connectionListeners = new ListenerRegistry<>();
    private final ListenerRegistry<ErrorListener> errorListeners = new ListenerRegistry<>();

    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final AtomicBoolean refreshScheduled = new AtomicBoolean(false);
    private final AtomicBoolean loggerFailureReported = new AtomicBoolean(false);
    private volatile boolean sawFirstRealtimeConnect = false;

    private EnvpitClient(String apiKey, String host, Duration pollInterval, Duration timeout,
                          HttpClient httpClient, EnvpitLogger logger, CacheState initial) {
        this.apiKey = apiKey;
        this.host = host;
        this.pollInterval = pollInterval;
        this.timeout = timeout;
        this.httpClient = httpClient;
        this.logger = logger;
        this.state = initial;

        if (pollInterval.compareTo(Duration.ZERO) > 0) {
            this.dispatchExecutor = Executors.newSingleThreadScheduledExecutor(daemonThreadFactory("envpit-dispatch"));
            this.pollTask = dispatchExecutor.scheduleAtFixedRate(
                    this::onPollTick, pollInterval.toMillis(), pollInterval.toMillis(), TimeUnit.MILLISECONDS);

            this.realtimeTransport = new RealtimeTransport(
                    this.host, this.apiKey, this.httpClient, pollInterval, SseFrameParser.DEFAULT_MAX_LINE_BYTES,
                    this::handlePushSignal, this::handleConnectionModeChange, this::safeLog, dispatchExecutor);
            this.realtimeThread = daemonThreadFactory("envpit-realtime").newThread(realtimeTransport::run);
            this.realtimeThread.start();
        } else {
            this.dispatchExecutor = null;
            this.pollTask = null;
            this.realtimeTransport = null;
            this.realtimeThread = null;
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    /** AC-SEC-SDK3-1: this type transitively holds the API key and the config snapshot — redact both. */
    @Override
    public String toString() {
        CacheState st = this.state;
        int keys = st != null ? st.snapshot().size() : 0;
        return "envpit.EnvpitClient(host=" + quote(host) + ", keys=" + keys + ", apiKey=<redacted>)";
    }

    private static String quote(String s) {
        return "\"" + s + "\"";
    }

    // ---- builder ------------------------------------------------------------------------------

    /**
     * Accumulates client configuration. The ONLY terminal method is {@link #load()} — see the
     * class doc comment for why there is deliberately no public {@code build()}.
     */
    public static final class Builder {
        private String apiKey;
        // null until host(...) is called; resolved in load() as explicit > ENVPIT_HOST env >
        // DEFAULT_HOST, mirroring apiKey (bd:envpit-ubky).
        private String host;
        private Duration pollInterval = DEFAULT_POLL_INTERVAL;
        private Duration timeout = DEFAULT_TIMEOUT;
        private HttpClient httpClient;
        private EnvpitLogger logger;
        private boolean loggerExplicitlySet = false;

        private Builder() {
        }

        /** Optional — falls back to the {@code ENVPIT_API_KEY} environment variable (INV-SDK-12). */
        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }

        /**
         * Optional — falls back to the {@code ENVPIT_HOST} environment variable, then
         * {@value EnvpitClient#DEFAULT_HOST} (bd:envpit-ubky). Override for self-hosted/local dev.
         */
        public Builder host(String host) {
            this.host = Objects.requireNonNull(host, "host");
            return this;
        }

        /**
         * Background refresh interval. Default 60s. A value {@code <= 0} disables ALL background
         * refresh, including the realtime (SSE) channel (INV-SDK-8) — {@code cacheInfo().refreshMode()}
         * reports {@link RefreshMode#OFF}.
         */
        public Builder pollInterval(Duration pollInterval) {
            this.pollInterval = Objects.requireNonNull(pollInterval, "pollInterval");
            return this;
        }

        /** Per-request timeout, applied to the initial load and every background poll/push/reconnect refresh. Default 5s. */
        public Builder timeout(Duration timeout) {
            this.timeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        /**
         * Overrides the {@link HttpClient} used for both the config fetch and the realtime (SSE)
         * connection — the test/injection seam (matching Node/Python/Go's {@code fetchImpl}/
         * {@code WithHTTPClient} precedent). AC-SEC-SDK3-3: this SDK exposes no TLS-bypass option
         * anywhere in its own public API. Whatever certificate-verification posture the {@link
         * HttpClient} you pass here has is entirely your own choice and your own responsibility —
         * the SDK does not validate or restrict what you pass here, and never ships a named
         * footgun of its own.
         */
        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = Objects.requireNonNull(httpClient, "httpClient");
            return this;
        }

        /**
         * Overrides the diagnostics sink. Default (when never called): a {@link JulEnvpitLogger}
         * — visible on stderr out of the box, zero-dependency (Uma SPEC-envpit-0t2z-3-1b-ux.md
         * §3.3). Pass {@code null} to silence all SDK log output.
         */
        public Builder logger(EnvpitLogger logger) {
            this.logger = logger;
            this.loggerExplicitlySet = true;
            return this;
        }

        /**
         * TERMINAL — the only way to obtain an {@link EnvpitClient}. Blocking: fetches the
         * environment's config once, synchronously (matches the Spring {@code @Bean}-method norm
         * — a bad key fails application-context startup fast, per Uma SPEC-envpit-0t2z-3-1b-ux.md
         * §1.3). Throws an {@link EnvpitException} subtype on failure — no client object ever
         * escapes a failed first load (INV-SDK-1).
         */
        public EnvpitClient load() {
            String resolvedApiKey = apiKey;
            if (resolvedApiKey == null || resolvedApiKey.isEmpty()) {
                resolvedApiKey = System.getenv("ENVPIT_API_KEY");
            }
            if (resolvedApiKey == null || resolvedApiKey.isEmpty()) {
                throw new AuthenticationException(
                        "EnvPit: no API key found. Set the ENVPIT_API_KEY environment variable, or call .apiKey(...) on the builder.");
            }

            // bd:envpit-ubky — mirror the ENVPIT_API_KEY fallback above: explicit host wins,
            // else ENVPIT_HOST from the environment, else the cloud default — so a self-hoster
            // who exports ENVPIT_API_KEY + ENVPIT_HOST reaches their own server, not the cloud.
            String resolvedHost = host;
            if (resolvedHost == null || resolvedHost.isEmpty()) {
                resolvedHost = System.getenv("ENVPIT_HOST");
            }
            if (resolvedHost == null || resolvedHost.isEmpty()) {
                resolvedHost = DEFAULT_HOST;
            }
            resolvedHost = stripTrailingSlash(resolvedHost);
            Duration resolvedTimeout = timeout != null ? timeout : DEFAULT_TIMEOUT;
            HttpClient resolvedHttpClient = httpClient != null ? httpClient : defaultHttpClient(resolvedTimeout);
            EnvpitLogger resolvedLogger = loggerExplicitlySet ? logger : new JulEnvpitLogger();

            Transport.FetchResult first = Transport.fetchConfig(resolvedHttpClient, resolvedHost, resolvedApiKey, resolvedTimeout);

            CacheState initial = new CacheState(
                    new ConfigSnapshot(first.values(), first.secretKeys()), Instant.now(), null, first.etag(),
                    pollInterval.compareTo(Duration.ZERO) > 0 ? RefreshMode.POLLING : RefreshMode.OFF,
                    null, null);

            return new EnvpitClient(resolvedApiKey, resolvedHost, pollInterval, resolvedTimeout,
                    resolvedHttpClient, resolvedLogger, initial);
        }
    }

    private static String stripTrailingSlash(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') {
            end--;
        }
        return s.substring(0, end);
    }

    private static HttpClient defaultHttpClient(Duration timeout) {
        return HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    private static ThreadFactory daemonThreadFactory(String name) {
        return r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true); // INV-SDK-11: background work must not keep the host process alive
            return t;
        };
    }

    // ---- getters --------------------------------------------------------------------------------

    /** Synchronous, in-memory read — never a network call (INV-SDK-2). Throws {@link MissingKeyException} if absent. */
    public String get(String key) {
        String raw = readRaw(key);
        if (raw == null) {
            throw new MissingKeyException(key);
        }
        return raw;
    }

    /** Same as {@link #get(String)}, returning {@code defaultValue} if the key is absent/null instead of throwing. */
    public String get(String key, String defaultValue) {
        String raw = readRaw(key);
        return raw != null ? raw : defaultValue;
    }

    /** Parses the value as a base-10 integer. Throws {@link MissingKeyException} if absent, {@link TypeMismatchException} if unparsable. */
    public int getInt(String key) {
        String raw = readRaw(key);
        if (raw == null) {
            throw new MissingKeyException(key);
        }
        return parseInt(key, raw);
    }

    /** Same as {@link #getInt(String)}, returning {@code defaultValue} if the key is absent/null instead of throwing. */
    public int getInt(String key, int defaultValue) {
        String raw = readRaw(key);
        if (raw == null) {
            return defaultValue;
        }
        return parseInt(key, raw);
    }

    /** Parses the value as a boolean (case-insensitive true/false, 1/0, yes/no, on/off). Throws as {@link #getInt(String)} does. */
    public boolean getBoolean(String key) {
        String raw = readRaw(key);
        if (raw == null) {
            throw new MissingKeyException(key);
        }
        return parseBoolean(key, raw);
    }

    /** Same as {@link #getBoolean(String)}, returning {@code defaultValue} if the key is absent/null instead of throwing. */
    public boolean getBoolean(String key, boolean defaultValue) {
        String raw = readRaw(key);
        if (raw == null) {
            return defaultValue;
        }
        return parseBoolean(key, raw);
    }

    private static int parseInt(String key, String raw) {
        String trimmed = raw.strip();
        if (!INTEGER_PATTERN.matcher(trimmed).matches()) {
            throw new TypeMismatchException(key, "integer", raw);
        }
        try {
            return Integer.parseInt(trimmed);
        } catch (NumberFormatException e) {
            throw new TypeMismatchException(key, "integer", raw);
        }
    }

    private static boolean parseBoolean(String key, String raw) {
        String normalized = raw.strip().toLowerCase(Locale.ROOT);
        if (TRUE_VALUES.contains(normalized)) {
            return true;
        }
        if (FALSE_VALUES.contains(normalized)) {
            return false;
        }
        throw new TypeMismatchException(key, "boolean", raw);
    }

    String readRaw(String key) {
        CacheState st = this.state;
        if (st == null) {
            // Structurally unreachable via the public API: the constructor only ever runs after
            // a successful first fetch (INV-SDK-1). Kept as a defensive guard, matching every
            // other language's identical "should be unreachable" guard.
            throw new IllegalStateException(
                    "envpit: config not loaded yet — this should be unreachable via EnvpitClient.builder()...load()");
        }
        return st.snapshot().get(key);
    }

    /** A point-in-time view of the client's in-memory cache. */
    public CacheInfo cacheInfo() {
        CacheState st = this.state;
        Duration age = Duration.between(st.fetchedAt(), Instant.now());
        return new CacheInfo(st.fetchedAt(), age, st.lastError(), st.etag(), st.refreshMode(), st.realtimeSince(), st.lastChangeAt());
    }

    // ---- native-mechanism merge (bd:envpit-yvyr) -----------------------------------------------

    /**
     * A defensive (shallow) copy of the current in-memory config snapshot — every key -&gt; value
     * pair this client currently holds, including keys present with a {@code null} value
     * (unset). Synchronous, in-memory read — never a network call, same guarantee as every
     * {@code get*()} getter.
     *
     * <p>Added for bd:envpit-yvyr — the ONE thing {@code envpit-spring-boot-starter} (a separate
     * Maven module/package, {@code com.envpit.spring}) needs from this core module to build a
     * Spring {@code PropertySource} at all: {@link ConfigSnapshot} (this package's internal
     * wrapper) is deliberately package-private and non-exposing (its own doc comment: "never
     * exposes its backing map" — AC-SEC-SDK3-1, the {@code toString()} leak boundary), so nothing
     * outside {@code com.envpit} could previously enumerate the full key set at all. This method
     * is the deliberate, public, opt-in export point — it does not weaken AC-SEC-SDK3-1, which is
     * about ACCIDENTAL leaks via {@code toString()}/logging, not an explicit caller asking for
     * every value by name. Mirrors Python's {@code EnvpitClient.snapshot()} (same bd, same
     * rationale). Mutating the returned {@link Map} never affects this client's own state.
     *
     * @throws IllegalStateException structurally unreachable via the public API — {@link
     *     Builder#load()} never returns a client without a successful first fetch (INV-SDK-1);
     *     kept as a defensive guard, matching {@link #readRaw(String)}'s identical guard.
     */
    public Map<String, String> snapshot() {
        CacheState st = this.state;
        if (st == null) {
            throw new IllegalStateException(
                    "envpit: config not loaded yet — this should be unreachable via EnvpitClient.builder()...load()");
        }
        ConfigSnapshot snap = st.snapshot();
        Map<String, String> copy = new LinkedHashMap<>();
        for (String key : snap.keySet()) {
            copy.put(key, snap.get(key));
        }
        return copy;
    }

    /**
     * The exact set of key NAMES (never values) the server flagged {@code is_secret=true} for
     * this environment, as of the last successful fetch (initial {@link Builder#load()} or a
     * background refresh — bd:envpit-durd closed the protocol gap this method used to be a
     * placeholder for). {@code GET /api/v1/config} ({@link Transport}) now returns an envelope,
     * {@code {values, secretKeys}} (test-vectors/resolve-body.json), instead of the pre-durd flat
     * {@code key -> value} map that carried no per-key signal at all — independently verified
     * against {@code apps/api/src/config-management/config-resolve.controller.ts}'s current
     * {@code @ApiResponse} schema in the main {@code envpit} repo. Same wire contract Python's
     * {@code client.py:_known_secret_keys()} and Node's {@code process-env-merge.ts} read.
     *
     * <p>A key present in {@code secretKeys} whose value is currently unset in this environment
     * still appears here (the flag is key-level, not value-level) — see {@code
     * unset-secret-is-still-listed} in resolve-body.json.
     *
     * <p>NOT a key-name heuristic (matching {@code SECRET}/{@code PASSWORD}/{@code TOKEN} in the
     * key name) — this is the real, server-reported flag; a heuristic would have been wrong in
     * both directions ({@code DATABASE_URL} commonly embeds a password and would slip past any
     * such pattern). Getters ({@link #get}, {@link #getInt}, {@link #getBoolean}) are UNCHANGED
     * by this method — they still return secret values by key name like any other value; only the
     * native-environment-merge path ({@code envpit-spring-boot-starter}'s {@code
     * EnvpitEnvironmentPostProcessor}, which folds this set into its excluded-key set unless a
     * deployment opts in via {@code envpit.include-secrets}) filters on it.
     *
     * <p>Unmodifiable defensive copy — mutating the returned {@link Set} never affects this
     * client's own state, matching {@link #snapshot()}'s identical guarantee.
     *
     * @throws IllegalStateException structurally unreachable via the public API — see {@link
     *     #snapshot()}'s identical guard.
     */
    public Set<String> knownSecretKeys() {
        CacheState st = this.state;
        if (st == null) {
            throw new IllegalStateException(
                    "envpit: config not loaded yet — this should be unreachable via EnvpitClient.builder()...load()");
        }
        return Set.copyOf(st.snapshot().secretKeys());
    }

    // ---- subscribe (callback-based; single daemon dispatch thread — see class doc comment) -----

    /**
     * Registered listener is invoked on the SDK's single daemon dispatch thread whenever the
     * served config differs from what it served before (INV-SDK-7). A throwing listener is caught
     * and logged; every other listener still runs (INV-SDK-6 / bd:envpit-r59g class).
     */
    public Subscription onChange(ChangeListener listener) {
        return changeListeners.add(Objects.requireNonNull(listener, "listener"));
    }

    /** Fires ONLY on an actual realtime-channel mode transition (INV-SDK-10), never once per (re)connect attempt. */
    public Subscription onConnection(ConnectionListener listener) {
        return connectionListeners.add(Objects.requireNonNull(listener, "listener"));
    }

    /** Fires for background-refresh failures — always a typed {@link EnvpitException}, never a raw transport error (bd:envpit-4dbm class). */
    public Subscription onError(ErrorListener listener) {
        return errorListeners.add(Objects.requireNonNull(listener, "listener"));
    }

    private void dispatchChange(ChangeEvent event) {
        for (ChangeListener l : changeListeners.forDispatch()) {
            invokeSafely("change", () -> l.onChange(event));
        }
    }

    private void dispatchConnection(ConnectionEvent event) {
        for (ConnectionListener l : connectionListeners.forDispatch()) {
            invokeSafely("connection", () -> l.onConnection(event));
        }
    }

    private void dispatchError(EnvpitException error) {
        for (ErrorListener l : errorListeners.forDispatch()) {
            invokeSafely("error", () -> l.onError(error));
        }
    }

    /**
     * Deliberately {@code catch (Exception)}, NEVER {@code catch (Throwable)} — the Java
     * over-catch trap Sara flagged (SPEC-envpit-0t2z-3-1a-architecture.md §3.3): catching {@link
     * Throwable} would also catch {@link Error} subclasses ({@link OutOfMemoryError}, {@link
     * StackOverflowError}, etc.), which must be allowed to propagate/crash, not be silently
     * swallowed by a listener-safety wrapper. Every OTHER registered listener still runs
     * ({@link ListenerRegistry}'s {@code CopyOnWriteArrayList} stable-snapshot iteration) —
     * bd:envpit-r59g class, INV-SDK-6/AC-SDK-05c.
     */
    private void invokeSafely(String eventName, Runnable action) {
        SafeInvoke.invoke(action,
                e -> safeLog("warn", "envpit: a config event listener threw (event: " + eventName + "): " + e.getMessage()));
    }

    /**
     * The SDK's one "invokes user-supplied code that isn't a registered listener" seam
     * (the {@link EnvpitLogger}) — routed through the same {@link SafeInvoke} wrapper as
     * {@link #invokeSafely}, so a pathological logger implementation can never crash a refresh
     * or dispatch either.
     */
    private void safeLog(String level, String message) {
        if (logger == null) {
            return;
        }
        SafeInvoke.invoke(() -> {
            switch (level) {
                case "debug" -> logger.debug(message);
                case "info" -> logger.info(message);
                case "warn" -> logger.warn(message);
                case "error" -> logger.error(message);
                default -> {
                }
            }
        }, e -> {
            if (loggerFailureReported.compareAndSet(false, true)) {
                System.err.println(
                        "envpit: the injected logger threw while handling an SDK log line; further logger failures will be suppressed");
            }
        });
    }

    // ---- internal refresh machinery (INV-SDK-4/5, AC-JV-01) -------------------------------------

    private void onPollTick() {
        // AC-JV-01: the periodic Runnable's ENTIRE body must be wrapped in its own try/catch —
        // ScheduledThreadPoolExecutor silently cancels ALL future executions of a
        // scheduleAtFixedRate task the moment one execution throws, with no log line anywhere
        // (the "worse than Node's crash, worse than Python's eventually-logged swallowed-task-
        // exception — it looks like the SDK is working while background refresh has permanently
        // stopped" footgun Bella flagged, SPEC-envpit-0t2z-3-1a-business.md §2).
        try {
            requestRefresh(ChangeTrigger.POLL);
        } catch (Exception e) {
            safeLog("error", "envpit: internal poll-tick dispatch failed unexpectedly: " + e.getMessage());
        }
    }

    void handlePushSignal(String etag) {
        CacheState st = this.state;
        if (st.etag() != null && !st.etag().isEmpty() && st.etag().equals(etag)) {
            return; // etag dedup (INV-SDK-9)
        }
        requestRefresh(ChangeTrigger.PUSH);
    }

    void handleConnectionModeChange(ConnectionMode mode, ConnectionReason reason, Instant since) {
        if (dispatchExecutor == null || dispatchExecutor.isShutdown()) {
            return;
        }
        // Routed onto the single dispatch executor thread — this callback arrives on the
        // dedicated realtime-reader thread, but listener invocation (dispatchConnection below)
        // must only ever happen on the one daemon dispatch thread (see class doc comment).
        dispatchExecutor.execute(() -> {
            try {
                onConnectionModeChangeOnDispatchThread(mode, reason, since);
            } catch (Exception e) {
                safeLog("error", "envpit: internal connection-mode-change dispatch failed unexpectedly: " + e.getMessage());
            }
        });
    }

    private void onConnectionModeChangeOnDispatchThread(ConnectionMode mode, ConnectionReason reason, Instant since) {
        CacheState prev = this.state;
        RefreshMode newRefreshMode = mode == ConnectionMode.REALTIME ? RefreshMode.REALTIME : RefreshMode.POLLING;
        Instant newRealtimeSince = mode == ConnectionMode.REALTIME ? since : null;
        this.state = new CacheState(prev.snapshot(), prev.fetchedAt(), prev.lastError(), prev.etag(),
                newRefreshMode, newRealtimeSince, prev.lastChangeAt());

        boolean sawFirst = sawFirstRealtimeConnect;
        if (mode == ConnectionMode.REALTIME) {
            sawFirstRealtimeConnect = true;
        }

        dispatchConnection(new ConnectionEvent(mode, since, reason));

        // Self-healing catch-up: refetch whenever the channel (re)connects, in case a change was
        // missed while it was down. Skipped on the very first realtime connect right after load —
        // that data is already fresh (INV-SDK-9).
        if (mode == ConnectionMode.REALTIME && sawFirst) {
            requestRefresh(ChangeTrigger.RECONNECT);
        }
    }

    /**
     * Funnels every refresh trigger (poll tick / push signal / reconnect catch-up) through the
     * SAME single dispatch executor thread (Bella SPEC-envpit-0t2z-3-1a-business.md §2 / OQ-SDK3-3
     * resolution — the "single-executor-funnel" structural fix, Java's analog of Go's coalescing
     * single-refresher goroutine). Because the executor is single-threaded, at most one {@link
     * #doRefresh} call is EVER running at a time — out-of-order resolution is impossible BY
     * CONSTRUCTION, the same reasoning Go's design uses (test-vectors/CONFORMANCE.md INV-SDK-5's
     * note: the conformance requirement is the OBSERVABLE invariant, not a literal generation-
     * counter mechanism). {@link #refreshScheduled} coalesces a burst of triggers arriving while a
     * refresh is already queued/running into at most one extra run (mirrors Go's buffered-channel-
     * of-1 coalescing) — the poll timer remains the correctness backstop regardless (INV-SDK-8).
     */
    private void requestRefresh(ChangeTrigger trigger) {
        if (closed.get() || dispatchExecutor == null) {
            return;
        }
        if (refreshScheduled.compareAndSet(false, true)) {
            dispatchExecutor.execute(() -> runRefreshTask(trigger));
        }
    }

    private void runRefreshTask(ChangeTrigger trigger) {
        try {
            doRefresh(trigger);
        } catch (Exception e) {
            // Defense-in-depth alongside AC-JV-01's onPollTick wrapper: execute()'s own Runnable
            // contract has the identical silent-swallow-with-no-log behavior for an uncaught
            // exception as scheduleAtFixedRate does — this must never permanently stop the
            // refresh pump either.
            safeLog("error", "envpit: internal refresh dispatch failed unexpectedly: " + e.getMessage());
        } finally {
            refreshScheduled.set(false);
        }
    }

    /** Runs on the single dispatch executor thread. Package-private so tests can drive it directly and deterministically. */
    void doRefresh(ChangeTrigger trigger) {
        Transport.FetchResult result;
        try {
            result = Transport.fetchConfig(httpClient, host, apiKey, timeout);
        } catch (EnvpitException fetchErr) {
            // Stale-while-revalidate (INV-SDK-4): a background refresh failure never propagates
            // to a get*() caller — recorded on cacheInfo, logged, and surfaced on the error
            // listeners (bd:envpit-4dbm-class guarantee: every transport failure, including a
            // mid-connection reset, is ALREADY mapped to a typed EnvpitException by Transport
            // before it ever reaches this catch — it never escapes unwrapped, and the error
            // listener path below is exactly where the fix's regression test proves it actually
            // fires on the refresh path, not just the initial-load path).
            CacheState prev = this.state;
            this.state = new CacheState(prev.snapshot(), prev.fetchedAt(), fetchErr, prev.etag(),
                    prev.refreshMode(), prev.realtimeSince(), prev.lastChangeAt());
            safeLog("warn", "envpit: background config refresh failed (" + fetchErr.getClass().getSimpleName() + "): "
                    + fetchErr.getMessage() + " — serving last known values");
            dispatchError(fetchErr);
            return;
        }

        CacheState prev = this.state;
        ConfigSnapshot previousSnapshot = prev.snapshot();
        ConfigSnapshot newSnapshot = new ConfigSnapshot(result.values(), result.secretKeys());
        Instant now = Instant.now();
        List<String> changed = SnapshotDiff.diff(previousSnapshot, newSnapshot);

        Instant lastChangeAt = changed.isEmpty() ? prev.lastChangeAt() : now;
        this.state = new CacheState(newSnapshot, now, null, result.etag(), prev.refreshMode(), prev.realtimeSince(), lastChangeAt);

        if (!changed.isEmpty()) {
            dispatchChange(new ChangeEvent(changed, result.etag(), now, trigger));
        }
    }

    // ---- close --------------------------------------------------------------------------------

    /**
     * Stops the background poll timer AND the realtime (SSE) connection. Idempotent. The last
     * snapshot remains readable after {@code close()} — only future background refresh and
     * listener delivery stop.
     *
     * <p><b>bd:envpit-tkvz-class fix, baked in from the start (carried-forward lesson from Go):
     * every scheduled task is explicitly cancelled here, and every executor is cleanly shut
     * down — no scheduled task, including the realtime channel's degraded-mode warn timer, can
     * fire after this method returns.</b> Two layers, matching the class-level design note on
     * {@link RealtimeTransport}: (1) {@link RealtimeTransport#run()}'s own {@code finally} block
     * cancels its warn {@link ScheduledFuture} on every exit path; (2) this method independently
     * cancels {@link #pollTask} AND shuts down {@link #dispatchExecutor} ({@code shutdown()} then
     * a bounded {@code awaitTermination()}, falling back to {@code shutdownNow()}) — so even a
     * hypothetical future bug in layer 1 still cannot let a scheduled task fire post-close.
     */
    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return; // idempotent
        }

        if (realtimeTransport != null) {
            realtimeTransport.requestStop();
        }
        if (realtimeThread != null) {
            realtimeThread.interrupt();
            try {
                realtimeThread.join(Duration.ofSeconds(5).toMillis());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (pollTask != null) {
            pollTask.cancel(false);
        }
        if (dispatchExecutor != null) {
            dispatchExecutor.shutdown();
            try {
                if (!dispatchExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                    dispatchExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                dispatchExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
    }
}
