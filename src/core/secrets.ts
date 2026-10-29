// Encryption at rest for secret settings (Illinois password, authenticator key, Discord token, webhook URL, push key).
// AES-256-GCM with a random key kept beside the database in secret.key (mode 0600). This protects a copied or
// shared app.sqlite. It cannot protect against someone who also has secret.key.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "v1";

export interface Cipher {
  encrypt(plain: string): string;
  /** null when the value cannot be decrypted (wrong or lost key, corrupted value). */
  decrypt(sealed: string): string | null;
}

export function makeCipher(key: Buffer): Cipher {
  if (key.length !== 32) throw new Error("secret key must be 32 bytes");
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
    },
    decrypt(sealed) {
      const parts = sealed.split(":");
      if (parts.length !== 4 || parts[0] !== PREFIX) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64url"));
        decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}

/** A key that only lives in this process (in-memory stores and tests). */
export function ephemeralCipher(): Cipher {
  return makeCipher(randomBytes(32));
}

/** Load `<dataDir>/secret.key`, creating it on first run. */
export function loadKeyFile(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "secret.key");
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${path} is not a valid key. Move it away to start over (saved passwords and tokens will need to be entered again).`);
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(path, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return key;
}
