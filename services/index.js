/**
 * Moved all fetch, json parsing and reply, timeout, retry and circuit-breaking to upstream util
 *
 */
const fastify = require('fastify')({ logger: true });
const { upstream } = require('../utils/upstream');
const isDev = process.env.NODE_ENV !== 'production';
if (isDev) require('../mock-server')();


fastify.get('/getUsers', async () => upstream('/getUsers', {}, fastify));

fastify.post('/addEvent', async (req, reply) => {
    try {
        const payload = { id: Date.now(), ...req.body };
        const data = await upstream('/addEvent', {
            method: 'POST',
            body: JSON.stringify(payload)
        }, fastify);

        reply.code(201).send(data);
    } catch (err) {
        if (err.statusCode === 503 && err.headers?.['Retry-After']) {
            reply.header('Retry-After', err.headers['Retry-After']);
        }

        throw err; // deliberately thrown
    }
});

fastify.get('/getEvents', async () => upstream('/getEvents', {}, fastify));

fastify.get('/getEventsByUserId/:id', async (req, reply) => {
    const { id } = req.params;
    const smallEventSize = 50

    const user = await upstream(`/getUserById/${id}`, {}, fastify);
    if (!user?.events?.length) return [];

    if (user.events.length > smallEventSize) {
        // paginate the upstream fetch for large event sets
        const chunked = [];
        for (let i = 0; i < user.events.length; i += smallEventSize) {
            const batch = user.events.slice(i, i + smallEventSize);
            chunked.push(batch);
        }

        const batchedResults = await Promise.all(
            chunked.map(async (batch) =>
                upstream(`/getEventsByIds?ids=${batch.join(',')}`, {}, fastify)
            )
        );

        return batchedResults.flat().filter(Boolean);
    }

    // parallelize for small sets where small is <= 50
    const results = await Promise.allSettled(
        user.events.map(eid => upstream(`/getEventById/${eid}`, {}, fastify))
    );

    return results
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);
});

// health, ready checks
fastify.get('/healthz', async () => ({ status: 'ok' }));
fastify.get('/readyz', async () => ({ status: 'ready' }));

fastify.listen({ port: process.env.PORT || 3000 }, (err) => {
    if (err) {
        fastify.log.error(err);
        process.exit(1);
    }
    fastify.log.info('Server is ready');
});
