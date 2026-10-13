import { stateDir } from "./config.ts";
import { acquireInstanceGuard } from "../scripts/instance-guard.ts";
export const releaseInstance = acquireInstanceGuard(stateDir);
