// Pins the blob provider the suite asserts against, BEFORE any module imports
// `config.ts` (which loads `.env`).
//
// The blob tests exercise the Postgres provider's semantics — same-origin
// upload PUTs, streaming 200 downloads, `data` held in the row — and the S3
// store has its own coverage through the in-memory double. A developer whose
// `.env` points local attachments at a real bucket (the normal setup here)
// would otherwise have the suite upload test objects into that bucket and
// fail on 302 redirects the tests never meant to test. `dotenv` never
// overrides a value already present, so setting it here wins over `.env`.
process.env.BLOB_STORAGE = "postgres";
