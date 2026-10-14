// Minimal token server for the PRIVATE ElevenLabs agent. No dependencies.
//
// Security rules (see sarj-agent-assessment/research/credentials_and_isolation.md):
// - Reads credentials ONLY from this project's .env file. Global environment variables are
//   deliberately ignored, so a work key in the shell can never be picked up by accident.
// - Never logs or returns the API key. The browser receives only a short-lived conversation token.
// - Binds to 127.0.0.1 (local machine only).
//
// Run (live mode only, after approval):  npm run token-server

// Compatibility entrypoint: all issuance now passes through shared authentication,
// approval, daily rate limits and remote configuration preflight.
await import('./demo-server.mjs');
