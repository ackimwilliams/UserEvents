 # Production Ready Event Management System
 

Assumptions:
1. security is outside the scope of this exercise.
2. delivery and rollout is outside the scope of this exercise

---

### Task 1:
Refactored the service to be production ready:
- Moved all fetch, json parsing and reply, timeout, retry and circuit-breaking to upstream util whereby creating
- added seeder script with retry and backoff logic for dev testing
- moved mock service into dev only
- fixed issue with retry.error() found at https://fastify.dev/docs/latest/Reference/Reply/#errors
- added more logging to aid observability


### Task 2: 

The issue with 
```js

fastify.get('/getEventsByUserId/:id', async (req) => {
    const user = await upstream(`/getUserById/${req.params.id}`, {}, fastify);
    if (!user?.events?.length) return [];
    const results = await Promise.all(
        user.events.map(eid => upstream(`/getEventById/${eid}`, {}, fastify))
    );
    return results.filter(Boolean);
});
```

is as follows:
1. it uses serial awaits resulting in N+1 calls per event
2. upstream returns unbounded results
3. the payloads are heavy, consider adding projection of fields fetching just the fields necessary 
4. faster alternatives to JSON.stringify() is available
5. Uses cold HTTP requests
6. Upstream responses are not cached
7. upstream doesn't offer filter/sorting allowing clients to request just the data they need

### If upstream calls get slower as the number of events increase, consider the following to speed up requests: 
1. for a small set of events, =< 50, parallelize calls to getEventById
2. if the number of events is not small, > 50,  parallelize in chunks of size = 50
3. Paginate events to support limit and offset query params and avoid returning unbounded results
4. cache events with a reasonable TTL, as needed,
5. select or specify just the fields you need isntead of all fields fields ie add projection of fields
5. Use fast-json-stringify (https://www.npmjs.com/package/fast-json-stringify) instead of JSON.stringify() as it's significantly faster for serialization
6. Use Promise.all() instead of `await` loops ie avoid N+1 calls per event
7. At upstream, consider adding filtering and sorting of the source data to limit request to just relevant payload
8. Utilize Undici (https://undici.nodejs.org/#/?id=benchmarks) to reuse open connections in node instead of making cold http requests each time


### Task 3:
- Implemented in code (https://github.com/ackimwilliams/UserEvents/blob/main/utils/upstream.js#L63)

## Future Changes:

- instead of writing retry loops with exponential backoff, counting failures, I would use proven libraries such as opossum (https://www.npmjs.com/package/opossum), axios-retry (https://www.npmjs.com/package/axios-retry) or p-retry (https://github.com/sindresorhus/p-retry)
- Implement caching with a reasonable TTL for events avoiding unnecessary upstream calls. I can create a simple cache helper if necessary
- Add unit and integration test suites especially around upstream helper methods

### Observability

- Improving tracing (datadog APM) and log correlation
- As Fastly uses Pino (https://www.npmjs.com/package/pino), consider adding more fields so that each log line offers more useful context
- create dashboard with SLOs and alerts 

