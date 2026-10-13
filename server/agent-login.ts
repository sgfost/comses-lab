import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie } from "hono/cookie";
import { randomBytes, randomInt } from "node:crypto";
import { db } from "./db.ts";
import { cookieName, tokenHash, type Principal } from "./auth.ts";
import { settings } from "./config.ts";
import { AuthoringError, type ApiContext } from "./authoring.ts";
import { human, insertGrant, validateGrantAccess, validateGrantRequest } from "./agent-grants.ts";
import type { User, CreateGrantRequest, AgentLoginRequest } from "../shared/contracts.ts";

export const agentLogin = new Hono<{ Variables: { user: User | undefined; principal: Principal | undefined } }>();
const loginBodyLimit = bodyLimit({ maxSize: 100000, onError: c => c.json({ error: { code: "request_too_large", message: "Login request exceeds 100 KB" } }, 413) });
agentLogin.use("/agent-login", loginBodyLimit);
agentLogin.use("/agent-login/*", loginBodyLimit);
interface LoginRow {
  device_hash: string; user_code: string; request: string; state: AgentLoginRequest["state"];
  expires_at: number; next_poll_at: number; poll_interval: number;
  approved_by: string | null; approved_request: string | null;
}
const limits = new Map<string, { until: number; count: number }>();
function limited(key: string, maximum: number) {
  const now = Date.now();
  for (const [id, value] of limits) if (value.until <= now) limits.delete(id);
  const limit = limits.get(key) ?? { until: now + 60000, count: 0 };
  limits.set(key, limit);
  return ++limit.count > maximum;
}
function anonymous(c: ApiContext) {
  if (getCookie(c, cookieName) !== undefined || c.req.header("Authorization") !== undefined) throw new AuthoringError(400, "invalid_request", "Start and poll agent login without cookies or Authorization");
}
function pendingRow(code: string) {
  const normalized = code.toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(normalized)) throw new AuthoringError(404, "invalid_user_code", "This code is invalid or expired");
  const row = db.prepare("SELECT * FROM agent_logins WHERE user_code=? AND expires_at>?").get(normalized, Date.now()) as unknown as LoginRow | undefined;
  if (!row) throw new AuthoringError(404, "invalid_user_code", "This code is invalid or expired");
  return row;
}
agentLogin.post("/agent-login", async c => {
  anonymous(c);
  if (limited("start", 30)) { c.header("Retry-After", "60"); return c.json({ error: { code: "rate_limited", message: "Too many login requests. Try again in a minute." } }, 429); }
  const value = await c.req.json().catch(() => null);
  const request = validateGrantRequest(value && typeof value === "object" && !Array.isArray(value) ? { projects: [], allowCreate: false, ...value } : value);
  db.prepare("DELETE FROM agent_logins WHERE expires_at<=?").run(Date.now());
  if (Number((db.prepare("SELECT count(*) AS count FROM agent_logins").get() as { count: number }).count) >= 200) return c.json({ error: { code: "rate_limited", message: "Too many login requests are waiting. Try again later." } }, 429);
  const deviceCode = randomBytes(32).toString("base64url");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let userCode: string;
  do { userCode = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(""); }
  while (db.prepare("SELECT 1 FROM agent_logins WHERE user_code=?").get(userCode));
  db.prepare("INSERT INTO agent_logins(device_hash,user_code,request,state,expires_at,next_poll_at) VALUES (?,?,?,'pending',?,?)").run(tokenHash(deviceCode), userCode, JSON.stringify(request), Date.now() + 600000, Date.now());
  const formatted = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
  const uri = `${settings.appOrigin}/#/agents/connect`;
  return c.json({ device_code: deviceCode, user_code: formatted, verification_uri: uri,
    verification_uri_complete: `${uri}?code=${formatted}`, expires_in: 600, interval: 5 }, 201);
});
agentLogin.post("/agent-login/token", async c => {
  anonymous(c);
  const value = await c.req.json().catch(() => null);
  if (!value || Object.keys(value).some(key => key !== "device_code") || typeof value.device_code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.device_code)) throw new AuthoringError(400, "invalid_request", "Use the private device_code from the login request");
  const row = db.prepare("SELECT * FROM agent_logins WHERE device_hash=?").get(tokenHash(value.device_code)) as unknown as LoginRow | undefined;
  if (!row) {
    if (limited("invalid-poll", 120)) return c.json({ error: { code: "rate_limited", message: "Too many invalid requests" } }, 429);
    throw new AuthoringError(400, "expired_token", "This login request is invalid or expired");
  }
  if (row.expires_at <= Date.now()) throw new AuthoringError(400, "expired_token", "This login request expired. Start a new login.");
  if (row.state === "denied") throw new AuthoringError(400, "access_denied", "The user denied access");
  if (row.state === "consumed") throw new AuthoringError(400, "authorization_consumed", "Credentials were already delivered. Start a new login if the response was lost.");
  if (row.next_poll_at > Date.now()) {
    const interval = Math.min(row.poll_interval + 5, 60);
    db.prepare("UPDATE agent_logins SET next_poll_at=?,poll_interval=? WHERE device_hash=?").run(Date.now() + interval * 1000, interval, row.device_hash);
    c.header("Retry-After", String(interval));
    return c.json({ error: { code: "slow_down", message: "Poll less frequently" }, interval }, 429);
  }
  db.prepare("UPDATE agent_logins SET next_poll_at=? WHERE device_hash=?").run(Date.now() + row.poll_interval * 1000, row.device_hash);
  if (row.state === "pending") return c.json({ error: { code: "authorization_pending", message: "Waiting for browser approval" }, interval: row.poll_interval }, 400);
  const user = db.prepare("SELECT id,username,display_name AS displayName FROM users WHERE id=?").get(row.approved_by!) as unknown as User | undefined;
  if (!user) throw new AuthoringError(400, "access_denied", "The approving account is unavailable");
  const request = JSON.parse(row.approved_request!) as CreateGrantRequest;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Check current project rights again, then consume approval and issue its grant atomically.
    const result = insertGrant(user, request);
    db.prepare("UPDATE agent_logins SET state='consumed',grant_id=? WHERE device_hash=?").run(result.grant.id, row.device_hash);
    db.exec("COMMIT");
    return c.json(result);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});
agentLogin.get("/agent-login/requests/:code", c => {
  const user = human(c);
  if (limited(`view:${user.id}`, 60)) return c.json({ error: { code: "rate_limited", message: "Too many code lookups. Try again in a minute." } }, 429);
  const row = pendingRow(c.req.param("code"));
  const request = JSON.parse(row.request) as CreateGrantRequest;
  return c.json({ request: { userCode: `${row.user_code.slice(0, 4)}-${row.user_code.slice(4)}`, ...request, allowCreate: !!request.allowCreate, state: row.state, expiresAt: row.expires_at } satisfies AgentLoginRequest });
});
agentLogin.post("/agent-login/requests/:code", async c => {
  const initial = human(c);
  const value = await c.req.json().catch(() => null);
  const user = human(c);
  if (user.id !== initial.id) throw new AuthoringError(401, "session_changed", "The original session is no longer valid");
  if (limited(`decide:${user.id}`, 60)) return c.json({ error: { code: "rate_limited", message: "Too many approval attempts. Try again in a minute." } }, 429);
  const row = pendingRow(c.req.param("code"));
  if (row.state !== "pending") throw new AuthoringError(409, "authorization_decided", "This request was already approved or denied");
  if (value?.decision === "deny" && Object.keys(value).length === 1) {
    db.prepare("UPDATE agent_logins SET state='denied',approved_by=? WHERE device_hash=?").run(user.id, row.device_hash);
    return c.json({ state: "denied" });
  }
  if (!value || value.decision !== "approve") throw new AuthoringError(400, "invalid_request", "Choose approve or deny");
  const { decision, ...fields } = value;
  const approved = validateGrantRequest(fields);
  validateGrantAccess(user, approved);
  db.prepare("UPDATE agent_logins SET state='approved',approved_by=?,approved_request=? WHERE device_hash=?").run(user.id, JSON.stringify(approved), row.device_hash);
  return c.json({ state: "approved" });
});
