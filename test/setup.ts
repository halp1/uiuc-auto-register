// Tests never run in live or rehearsal mode and never touch real credentials.
process.env.NODE_ENV = "test";
process.env.REGISTRATION_MODE = "simulated";
delete process.env.UIUC_NETID;
delete process.env.UIUC_PASSWORD;
delete process.env.UIUC_TOTP_SECRET;
