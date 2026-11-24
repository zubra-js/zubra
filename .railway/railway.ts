// The hosted demos on Railway: one project, one service per folder in deploy/, each built from this
// repository with deploy/<demo>/Dockerfile and the settings in deploy/<demo>/railway.json (Railway's
// build and deploy fields: the Dockerfile, the paths whose changes rebuild it, sleeping when idle).
//
//   cd .railway && npm ci && railway config plan     # what would change
//   railway config apply                             # change it
//
// Railway reads this only when it's applied. The services have no GitHub source: they're deployed
// from a checkout by deploy/up.mjs (railway up), on a machine or runner of your own.
//
// This file is the whole project: a service with no folder in deploy/ is deleted by an apply.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRailway, project, service } from "railway/iac";

const deploy = join(dirname(fileURLToPath(import.meta.url)), "../deploy");

export default defineRailway(() => {
  const demos = readdirSync(deploy).filter((id) => existsSync(join(deploy, id, "railway.json"))).sort();
  const services = demos.map((id) => {
    const { build, deploy: settings } = JSON.parse(readFileSync(join(deploy, id, "railway.json"), "utf8"));
    // The service's domain is on 8080, so the port is said here, not left to Railway to pick.
    return service(id, { build, deploy: settings, env: { PORT: "8080" } });
  });
  return project("zubra-demos", { resources: services });
});
