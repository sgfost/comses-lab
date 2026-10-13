import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { db } from "./db.ts";
import type { User } from "../shared/contracts.ts";
import type { LaunchPrincipal } from "../runtime/server.ts";
export type Principal =
  | { kind: "session"; user: User; credentialHash: string }
  | { kind: "agent"; user: User; credentialHash: string; grantId: string };
export class AuthError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const cookieName = "lab_session";
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(
    Buffer.from(hash!, "hex"),
    scryptSync(password, salt!, 64),
  );
}
export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function sessionUser(token?: string): User | undefined {
  if (!token) return;
  return db
    .prepare(
      `SELECT u.id,u.username,u.display_name AS displayName FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`,
    )
    .get(tokenHash(token), Date.now()) as unknown as User | undefined;
}
export function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now());
  db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
    tokenHash(token),
    userId,
    Date.now() + 7 * 86400000,
  );
  return token;
}
export function readPrincipal(cookie?: string, authorization?: string): Principal | undefined {
  if (authorization !== undefined) {
    if (cookie !== undefined) throw new AuthError("ambiguous_credentials", "Use either a session or a bearer credential");
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    if (!token) throw new AuthError("unauthorized", "Invalid bearer credential");
    const credentialHash = tokenHash(token);
    const row = db.prepare(`SELECT g.id AS grantId,u.id,u.username,u.display_name AS displayName FROM agent_grants g JOIN users u ON u.id=g.owner_id WHERE g.token_hash=? AND g.state='active'`).get(credentialHash) as
      (User & { grantId: string }) | undefined;
    if (!row) throw new AuthError("unauthorized", "Invalid bearer credential");
    const { grantId, ...user } = row;
    return { kind: "agent", user, grantId, credentialHash };
  }
  const user = sessionUser(cookie);
  return user ? { kind: "session", user, credentialHash: tokenHash(cookie!) } : undefined;
}
export function principalLive(principal: Principal): boolean {
  if (principal.kind === "session") return !!db.prepare("SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?").get(principal.credentialHash, principal.user.id, Date.now());
  return !!db.prepare("SELECT 1 FROM agent_grants WHERE id=? AND owner_id=? AND token_hash=? AND state='active'").get(principal.grantId, principal.user.id, principal.credentialHash);
}
export function launchPrincipal(principal: Principal): LaunchPrincipal {
  return principal.kind === "session"
    ? { kind: "session", userId: principal.user.id, sessionId: principal.credentialHash }
    : { kind: "agent", userId: principal.user.id, grantId: principal.grantId };
}
