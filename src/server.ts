#!/usr/bin/env bun
/** Metro daemon entrypoint (CLI-independent): boots the dispatcher (supervisor +
 *  outbox + webhook/monitor HTTP+SSE API) with NO argv parsing, so the daemon runs
 *  without the CLI. Thin re-export of ./dispatcher.js (top-level `await main()`). */
import './dispatcher.js'
