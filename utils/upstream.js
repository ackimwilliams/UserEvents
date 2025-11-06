/**
 * This util centralizes all outbound api logic and ensures
 * consistent timeout, retry, and logging behavior.  It also protects
 * the upstream service from getting slammed by heavy load and resets
 * the circuit breaker once upstream is healthy again. Ideas on retry logic,
 * exponential backoff were taken from popular npm packages:
 *
 * opossum (https://www.npmjs.com/package/opossum)
 * axios-retry (https://www.npmjs.com/package/axios-retry)
 * p-retry (https://github.com/sindresorhus/p-retry)
 */

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_RETRIES = 2;
const BACKOFF_FACTOR = 2;

const FAILURE_WINDOW_MS = 30000;
const FAILURE_THRESHOLD = 3;
const OPEN_COOLDOWN_MS = 30000;
const HALF_OPEN_PROBE_INTERVAL_MS = 5000;

const defaultBase = 'http://event.com';

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };
let state = STATE.CLOSED;
let failureTimes = [];
let openUntil = 0;
let nextProbeAt = 0;
let probeInFlight = false;

const now = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pruneFailures(ts = now()) {
    const cutoff = ts - FAILURE_WINDOW_MS;
    failureTimes = failureTimes.filter(t => t >= cutoff);
}

function recordFailure(ts = now()) {
    pruneFailures(ts);
    failureTimes.push(ts);

    if (state === STATE.CLOSED && failureTimes.length >= FAILURE_THRESHOLD) {
        state = STATE.OPEN;
        openUntil = ts + OPEN_COOLDOWN_MS;
    }
}

function recordSuccess() {
    failureTimes = [];
    state = STATE.CLOSED;
    openUntil = 0;
    nextProbeAt = 0;
    probeInFlight = false;
}

async function upstream(path, init = {}, fastify, {
    base = process.env.UPSTREAM_BASE || defaultBase,
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const ts = now();

    // breaker short-circuiting
    if (state === STATE.OPEN) {
        if (ts >= openUntil) {
            state = STATE.HALF_OPEN;
            nextProbeAt = ts;
        } else {
            const err = fastify.httpErrors.serviceUnavailable('Upstream circuit open');
            err.headers = { 'Retry-After': Math.ceil((openUntil - ts) / 1000) };

            throw err;
        }
    }

    if (state === STATE.HALF_OPEN) {
        if (probeInFlight || ts < nextProbeAt) {
            const err = fastify.httpErrors.serviceUnavailable('Upstream circuit half-open');
            err.headers = { 'Retry-After': Math.ceil((nextProbeAt - ts) / 1000) };

            throw err;
        }

        probeInFlight = true;
        nextProbeAt = ts + HALF_OPEN_PROBE_INTERVAL_MS;
    }

    // per-request retry with exponential backoff
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(base + path, {
                ...init,
                signal: controller.signal,
                headers: { 'content-type': 'application/json', ...(init.headers || {}) }
            });

            clearTimeout(timer);

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                const e = new Error(`Upstream ${res.status} ${res.statusText}: ${text}`);
                e.statusCode = res.status;

                throw e;
            }

            // success
            if (state === STATE.HALF_OPEN)
                recordSuccess();
            else
                pruneFailures();

            return await res.json();

        } catch (err) {
            clearTimeout(timer);

            const transient =
                err.name === 'AbortError' ||
                (err.statusCode && err.statusCode >= 500);

            const lastAttempt = attempt > MAX_RETRIES;

            if (!transient || lastAttempt) {
                // count failure & manage state
                recordFailure();

                if (state === STATE.HALF_OPEN) {
                    state = STATE.OPEN;
                    probeInFlight = false;
                    openUntil = now() + OPEN_COOLDOWN_MS;
                }

                const e = fastify.httpErrors.serviceUnavailable('Upstream service unavailable');
                e.headers = { 'Retry-After': Math.ceil(OPEN_COOLDOWN_MS / 1000) };
                throw e;
            }

            // backoff
            const delay = 100 * Math.pow(BACKOFF_FACTOR, attempt - 1);
            fastify.log.warn({ attempt, delay, err }, 'Retrying upstream request');

            await sleep(delay);
        } finally {
            if (state === STATE.HALF_OPEN) {
                probeInFlight = false;
            }
        }
    }
}

module.exports = { upstream };
