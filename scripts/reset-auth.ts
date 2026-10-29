// Locked out? Turns off the app password and removes passkeys, recovery codes and signed-in browsers.
// Your courses, settings and Banner login stay. Running this on the server is the proof that it's you.
//   bun run reset-auth [--data ./data]
//   docker exec uiuc-auto-register bun run reset-auth --data /data

import { AccessControl } from "../src/auth/access";
import { parseArgs } from "../src/core/config";
import { Store } from "../src/core/db";

const { dataDir } = parseArgs(process.argv.slice(2));
const store = Store.open(dataDir);
AccessControl.reset(store);
store.close();
console.log(`Sign-in is off for the app in ${dataDir}. Open the app and turn the password back on in Settings, Security.`);
