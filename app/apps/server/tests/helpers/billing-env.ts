// Vitest setupFile: runs before any test module imports `config`, so the Polar
// webhook secret + product ids are captured by config at import time and the
// real PolarBillingProvider can verify signatures in tests.
//
// It forces POLAR_ACCESS_TOKEN to empty. `billingEnabled()` reads that live
// from the environment, so billing stays OFF for every suite by default (no
// free-tier limits enforced anywhere), even when a developer's local .env sets
// a real token: `dotenv/config` (imported by src/config.ts after this file
// runs) never overrides a key that is already defined, empty or not. A test
// that needs billing on stubs it itself with vi.stubEnv; vi.unstubAllEnvs
// restores this empty value.
process.env.POLAR_ACCESS_TOKEN = "";
process.env.POLAR_WEBHOOK_SECRET ||= "test-polar-webhook-secret";
process.env.POLAR_PRODUCT_MONTHLY_ID ||= "prod_monthly_test";
process.env.POLAR_PRODUCT_YEARLY_ID ||= "prod_yearly_test";
