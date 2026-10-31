// Test-only preload: lets DB-backed tests reuse the configured MONGODB_URI as
// TEST_MONGODB_URI. The tests always connect to the separate
// `merchant_autopilot_test` database and clean up their own fixtures.
require('dotenv').config();
if (!process.env.TEST_MONGODB_URI && process.env.MONGODB_URI) {
  process.env.TEST_MONGODB_URI = process.env.MONGODB_URI;
}
