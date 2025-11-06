'use strict';

// setup configs
const BASE = process.env.API_BASE || 'http://localhost:3000';
const ADD_EVENT_PATH = '/addEvent';
const READY = '/readyz';

const SEED_COUNT = Number(process.env.SEED_COUNT || 25);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 4));

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 2000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 2);
const BACKOFF_BASE_MS = Number(process.env.BACKOFF_BASE_MS || 150);

// helpers functions
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitUntilReady(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
        attempt++;
        try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 1000);
            const res = await fetch(BASE + READY, { signal: ac.signal });
            clearTimeout(t);
            if (res.ok) return true;
        } catch (_) { /* ignore */ }
        const backoff = Math.min(200 * attempt, 1000);
        await sleep(backoff);
    }
    throw new Error(`Server at ${BASE} not ready (tried ${attempt} times)`);
}

async function postWithRetry(body, { timeoutMs = TIMEOUT_MS } = {}) {
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(BASE + ADD_EVENT_PATH, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body)
            });
            clearTimeout(timer);

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                const err = new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
                err.statusCode = res.status;
                throw err;
            }
            return await res.json();
        } catch (err) {
            clearTimeout(timer);
            const transient = err.name === 'AbortError' || (err.statusCode && err.statusCode >= 500);
            const finalAttempt = attempt > MAX_RETRIES;
            if (!transient || finalAttempt) {
                throw err;
            }
            const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
            console.warn(`[seed] transient failure (attempt ${attempt}): ${err.message}; retrying in ${backoff}ms`);
            await sleep(backoff);
        }
    }
}

function* generateEvents(count) {
    const users = [1, 2, 3];
    for (let i = 1; i <= count; i++) {
        const userId = users[(i - 1) % users.length];
        yield {
            userId,
            name: `Seeded Event ${i}`,
            details: `Auto-generated event #${i} for user ${userId}`
        };
    }
}

async function runQueue(items, concurrency, worker) {
    let inFlight = 0, idx = 0, ok = 0, fail = 0;
    return new Promise((resolve) => {
        const results = [];
        const next = () => {
            if (idx >= items.length && inFlight === 0) {
                return resolve({ ok, fail, results });
            }
            while (inFlight < concurrency && idx < items.length) {
                const currentIndex = idx++;
                const item = items[currentIndex];
                inFlight++;
                worker(item, currentIndex)
                    .then((r) => { results[currentIndex] = r; ok++; })
                    .catch((e) => { results[currentIndex] = { error: e.message }; fail++; })
                    .finally(() => { inFlight--; next(); });
            }
        };
        next();
    });
}

async function main() {
    console.log(`[seed] Waiting for ${BASE}${READY} ...`);
    await waitUntilReady();

    const payloads = Array.from(generateEvents(SEED_COUNT));

    console.log(`[seed] Seeding ${payloads.length} events → ${BASE}${ADD_EVENT_PATH} with concurrency=${CONCURRENCY}`);
    const t0 = Date.now();

    const { ok, fail } = await runQueue(payloads, CONCURRENCY, (evt, i) =>
        postWithRetry({ ...evt }).then(res => {
            console.log(`[seed] #${i + 1} ->`, res);
            return res;
        })
    );

    const ms = Date.now() - t0;
    console.log(`[seed] Done. success=${ok}, failed=${fail}, time=${ms}ms`);
    if (fail > 0) process.exitCode = 1;
}

main().catch(err => {
    console.error('[seed] Fatal:', err);
    process.exit(1);
});
