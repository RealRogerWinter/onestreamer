const {
    getTraceId,
    runWithTraceId,
    makeTraceId,
    expressMiddleware,
} = require('../../bootstrap/trace-context');

describe('bootstrap/trace-context — request-scoped trace IDs (ADR-0020 §4)', () => {
    describe('getTraceId / runWithTraceId', () => {
        it('getTraceId is undefined outside any scope', () => {
            expect(getTraceId()).toBeUndefined();
        });

        it('runWithTraceId makes the ID visible inside the scope', () => {
            let inside;
            runWithTraceId('abc12345', () => {
                inside = getTraceId();
            });
            expect(inside).toBe('abc12345');
        });

        it('getTraceId reverts to undefined after the scope ends', () => {
            runWithTraceId('abc12345', () => {});
            expect(getTraceId()).toBeUndefined();
        });

        it('nested scopes pick up the inner ID', () => {
            let seen;
            runWithTraceId('outer', () => {
                runWithTraceId('inner', () => {
                    seen = getTraceId();
                });
            });
            expect(seen).toBe('inner');
        });

        it('the inner scope does not leak into the outer scope on return', () => {
            const observations = [];
            runWithTraceId('outer', () => {
                observations.push(getTraceId());
                runWithTraceId('inner', () => {
                    observations.push(getTraceId());
                });
                observations.push(getTraceId());
            });
            expect(observations).toEqual(['outer', 'inner', 'outer']);
        });

        it('survives async boundaries — Promise then', async () => {
            const seen = await runWithTraceId('xyz', async () => {
                await Promise.resolve();
                return getTraceId();
            });
            expect(seen).toBe('xyz');
        });

        it('survives async boundaries — setImmediate', (done) => {
            runWithTraceId('async-id', () => {
                setImmediate(() => {
                    try {
                        expect(getTraceId()).toBe('async-id');
                        done();
                    } catch (err) {
                        done(err);
                    }
                });
            });
        });
    });

    describe('makeTraceId', () => {
        it('returns an 8-char alphanumeric string', () => {
            const id = makeTraceId();
            expect(id).toMatch(/^[a-f0-9]{8}$/);
        });

        it('returns different IDs on consecutive calls', () => {
            const ids = new Set();
            for (let i = 0; i < 100; i++) ids.add(makeTraceId());
            expect(ids.size).toBe(100);
        });
    });

    describe('expressMiddleware', () => {
        function makeReq(headers = {}) {
            return { headers };
        }
        function makeRes() {
            const headers = {};
            return {
                setHeader: jest.fn((k, v) => { headers[k] = v; }),
                _headers: headers,
            };
        }

        it('mints a fresh trace ID when no X-Trace-Id header is present', () => {
            const req = makeReq();
            const res = makeRes();
            let captured;
            expressMiddleware(req, res, () => {
                captured = getTraceId();
            });
            expect(captured).toMatch(/^[a-f0-9]{8}$/);
            expect(res.setHeader).toHaveBeenCalledWith('x-trace-id', captured);
        });

        it('reuses the incoming X-Trace-Id header when it matches the safe pattern', () => {
            const req = makeReq({ 'x-trace-id': 'chained-abc-123' });
            const res = makeRes();
            let captured;
            expressMiddleware(req, res, () => {
                captured = getTraceId();
            });
            expect(captured).toBe('chained-abc-123');
            expect(res.setHeader).toHaveBeenCalledWith('x-trace-id', 'chained-abc-123');
        });

        it('rejects a malicious X-Trace-Id (special chars) and mints a fresh one', () => {
            const req = makeReq({ 'x-trace-id': 'bad" header\ninjection' });
            const res = makeRes();
            let captured;
            expressMiddleware(req, res, () => {
                captured = getTraceId();
            });
            expect(captured).not.toBe('bad" header\ninjection');
            expect(captured).toMatch(/^[a-f0-9]{8}$/);
        });

        it('rejects an X-Trace-Id longer than 64 chars and mints a fresh one', () => {
            const tooLong = 'a'.repeat(65);
            const req = makeReq({ 'x-trace-id': tooLong });
            const res = makeRes();
            let captured;
            expressMiddleware(req, res, () => {
                captured = getTraceId();
            });
            expect(captured).not.toBe(tooLong);
            expect(captured).toMatch(/^[a-f0-9]{8}$/);
        });

        it('echoes the trace ID back on the response x-trace-id header', () => {
            const req = makeReq();
            const res = makeRes();
            expressMiddleware(req, res, () => {});
            expect(res.setHeader).toHaveBeenCalledTimes(1);
            const [headerName, headerValue] = res.setHeader.mock.calls[0];
            expect(headerName).toBe('x-trace-id');
            expect(headerValue).toMatch(/^[a-f0-9]{8}$/);
        });
    });
});
