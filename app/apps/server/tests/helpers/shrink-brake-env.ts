// Vitest setupFile: the shrink burst brake (`src/versions/shrink-guard.ts`) is
// process-wide state, and many suites empty several notes as one user within a
// minute on purpose. Off by default under test; the brake's own suite turns it
// on with `shrinkBrake.configure(...)`.
process.env.SHRINK_BRAKE_COUNT ||= "0";
