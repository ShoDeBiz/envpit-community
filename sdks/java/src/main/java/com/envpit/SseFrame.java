package com.envpit;

/** One dispatched server-sent-events frame. */
record SseFrame(String event, String data) {
}
