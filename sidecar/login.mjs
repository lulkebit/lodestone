// One-shot Microsoft device-code login. Spawned per "add account".
//   argv: <cacheKey> <cacheDir>
// Emits: auth_code, then auth_success | auth_error, then exits.

import prismarineAuth from "prismarine-auth";
const { Authflow } = prismarineAuth;
import { AUTH_OPTS, send, exitWithParent } from "./shared.mjs";

exitWithParent();

const cacheKey = process.argv[2];
const cacheDir = process.argv[3];

const flow = new Authflow(cacheKey, cacheDir, AUTH_OPTS, (resp) =>
  send({
    event: "auth_code",
    user_code: resp.user_code,
    verification_uri: resp.verification_uri,
  })
);

flow
  .getMinecraftJavaToken({ fetchProfile: true })
  .then((res) => {
    if (!res || !res.profile || !res.profile.name) {
      // i18n key — the frontend translates known error keys.
      throw new Error("auth.error.noProfile");
    }
    send({
      event: "auth_success",
      id: cacheKey,
      username: res.profile.name,
      uuid: res.profile.id,
    });
    process.exit(0);
  })
  .catch((e) => {
    send({ event: "auth_error", message: e?.message || String(e) });
    process.exit(1);
  });
