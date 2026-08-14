/**
 * Loaded before any test module, via --import in the test scripts.
 *
 * env.ts validates the whole configuration at import time and exits if it is
 * incomplete, which is right for a server and awkward for a test: ESM hoists
 * every import above any code in the file, so a test cannot set these itself
 * before the module it is testing reads them.
 *
 * Nothing here is a secret. The database URL is only used by tests that talk to
 * a database, and those are skipped when TEST_DATABASE_URL is not set.
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/foundation_test';
process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_long_enough_1234567890';
process.env.ENCRYPTION_KEY ??= 'test_encryption_key_thirty_two_bytes_ok';
process.env.ADMIN_USERNAME ??= 'admin';
process.env.ADMIN_PASSWORD ??= 'Test_Admin_9271';
process.env.UPLOAD_DIR ??= '/tmp/foundation-test-uploads';
process.env.BACKUP_DIR ??= '/tmp/foundation-test-backups';

/**
 * Short by design. A test that waits three minutes for a provider timeout is a
 * test nobody runs; these are the values the streaming tests measure against.
 */
process.env.LLM_TIMEOUT_MS ??= '1500';
process.env.LLM_MAX_MS ??= '8000';
