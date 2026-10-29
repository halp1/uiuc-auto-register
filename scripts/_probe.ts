// Shared setup for the read-only probes. They always run in Test mode (writes blocked), whatever mode the app
// is set to, and read the Illinois login saved in the app's data folder.
//   bun run probe:<name> [--data ./data] [args]

import { credentialsFromSettings, type Credentials } from "../src/auth/login";
import { makeConfig, parseArgs, type Config } from "../src/core/config";
import { Store } from "../src/core/db";

export interface ProbeSetup {
  config: Config;
  credentials: Credentials;
  /** Positional arguments with --data/--port/--host removed. */
  args: string[];
}

export function probeSetup(name: string): ProbeSetup {
  const argv = process.argv.slice(2);
  const cli = parseArgs(argv);
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (/^--(data|port|host)$/.test(a)) i++;
    else if (!/^--(data|port|host)=/.test(a)) args.push(a);
  }
  const saved = Store.open(cli.dataDir);
  const credentials = credentialsFromSettings(saved.getSettings());
  saved.close();
  if (!credentials) {
    console.error(`${name}: no saved login in ${cli.dataDir}. Finish setup in the app first, or pass --data <folder>.`);
    process.exit(2);
  }
  // Test mode is forced here: probes never register.
  return { config: makeConfig("rehearsal", cli), credentials, args };
}
