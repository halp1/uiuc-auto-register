// The app reads no environment variables. Tests build their own Config and in-memory stores,
// so they never see a saved login and never reach the real account.
process.env.NODE_ENV = "test";
