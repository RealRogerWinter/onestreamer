process.env.NODE_ENV = 'test';
process.env.COOLDOWN_SECONDS = '30';
// Driver default flip (ADR-0014 Phase C): test processes keep node-sqlite3
// as the AMBIENT driver so the main config never loads better-sqlite3
// through database.js's module-load gate (the two bindings must not co-load
// in the unit-suite process, and fresh-boot-schema.test.js requires the
// real database.js). Driver coverage is explicit: every driver-matrix test
// pins the flag per-describe, the isolated *.bettersqlite suites pin 'true',
// and the CI bettersqlite job boot-smokes the real unset-flag default.
process.env.USE_BETTER_SQLITE3 = 'false';