// Vitest setupFile: turns outbound email ON with the in-memory transport before
// any test module imports `auth.ts`, which decides at import time whether to
// register the password-reset / verification / invitation hooks. With it every
// suite exercises the real hooks and can read what "went out" from
// `memoryOutbox` (src/email/mailer.ts) — no SMTP, no network.
process.env.EMAIL_FROM ||= "Baalda Test <test@baalda.local>";
process.env.EMAIL_TRANSPORT ||= "memory";
