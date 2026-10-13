import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config, stateDir } from "../scripts/config.mjs";
export const settings = config() as {
  instance: string;
  appPort: number;
  apiPort: number;
  runtimePort: number;
  forgejoPort: number;
  appOrigin: string;
  runtimeOrigin: string;
  forgejoUrl: string;
  composeProject: string;
};
export { stateDir };
export type Credential = {
  username: string;
  password: string;
  displayName: string;
};
export function credentials(): {
  admin: Credential;
  reader: Credential;
  users: Credential[];
} {
  return JSON.parse(
    readFileSync(resolve(stateDir, "credentials.json"), "utf8"),
  );
}
