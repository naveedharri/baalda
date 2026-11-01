// Vitest setupFile: password unlock (ACCOUNT_KEY_PEPPER) is OFF for every suite
// by default, even when a developer's local .env sets a pepper, so login hashes
// stay plain argon2id unless a test turns it on. `dotenv/config` never overrides
// a key that is already defined, empty or not; suites that need it stub it with
// vi.stubEnv, and vi.unstubAllEnvs restores this empty value.
process.env.ACCOUNT_KEY_PEPPER = "";
