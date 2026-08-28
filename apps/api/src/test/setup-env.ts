/**
 * Test environment. Values are non-functional placeholders — no real credentials, no real
 * data. The API under test never reaches an external provider in unit tests (13_REAL_DATA
 * §13.7: we simulate transport/infrastructure failure, never observation content).
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.PUBLIC_APP_URL = 'http://localhost:5173';
// Integration tests use a throwaway database on the local mongod; unit tests never connect.
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST ?? 'mongodb://localhost:27017';
process.env.MONGODB_DB_NAME = 'varuna_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_BUCKET = 'varuna-test';
process.env.S3_ACCESS_KEY_ID = 'test';
process.env.S3_SECRET_ACCESS_KEY = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000000';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-00000';
process.env.ML_SERVICE_URL = 'http://localhost:8000';
process.env.ML_SERVICE_TOKEN = 'test';
process.env.TITILER_URL = 'http://localhost:8001';
