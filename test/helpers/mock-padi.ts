/**
 * An in-process mock of the PADI APIs, for integration tests. Nothing here talks to PADI.
 *
 * - AWS Cognito InitiateAuth (USER_PASSWORD_AUTH, REFRESH_TOKEN_AUTH)
 * - the PADI auth API (/auth/api/oauth/login and /oauth/refresh)
 * - the logbook GraphQL API in both transports: the proxy (/api/Logbook, every query scoped by
 *   $affiliate_id) and the direct Hasura endpoint (/v1/graphql, scoped by the token)
 * - the REST endpoints around it: instructor lookup (both hosts), eCards and dive photos
 * - the certification photo (the profile photo of the PADI website): the photo API answers a
 *   pre-signed link to a fake storage host (/photo-storage/) on the same server, which refuses
 *   requests that carry a PADI token, as a real storage host would
 *
 * The logbook data lives in a DemoLogbookStore per account, so the database rules are the same as
 * in the demo backend (typed columns, array literals, MM/DD/YYYY dates, no cascade). GraphQL
 * documents are parsed for real (a small parser below), and answers are projected on the selection
 * set, so a client only gets the fields it asked for.
 *
 * All data is invented. Use `mock.env()` for the PADI_* operator overrides of the server.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DEMO_INSTRUCTORS, sampleDives } from "../../src/demo/logbook-data.js";
import { CHILD_RELATION, checkUnits, DemoLogbookStore, DemoPadiError, ilikeToRegExp, type DemoSeed, type DemoTable } from "../../src/demo/logbook.js";

// ---------------------------------------------------------------------------------------------
// Accounts and tokens
// ---------------------------------------------------------------------------------------------

export interface MockAccountOptions {
  email: string;
  password: string;
  affiliateId: string;
  givenName?: string;
  familyName?: string;
  /** "2" or "3" for a PADI Pro. */
  affiliateTypeId?: string;
  /** The logbook (default: the invented sample dives). */
  seed?: DemoSeed;
  /** The certification photo (default: none, status NO_PHOTO). */
  certificationPhoto?: MockCertificationPhoto;
}

/** A certification photo: its status at PADI ("APPROVED", "NO_PHOTO", "PENDING", ...) and its file. */
export interface MockCertificationPhoto {
  status: string;
  data?: Buffer;
  type?: string;
}

export interface MockAccount extends Required<Omit<MockAccountOptions, "seed">> {
  store: DemoLogbookStore;
  /** Photos by dive id. */
  photos: Map<number, Array<{ id: string; mimeType: string; data: Buffer }>>;
}

export interface MockPadiOptions {
  accounts?: MockAccountOptions[];
  /** The app client id the mock accepts (PADI_CLIENT_ID). */
  clientId?: string;
  /** Lifetime of an ID token, in seconds (PADI: 3600). */
  idTokenTtlSec?: number;
  timeZone?: string;
}

/** The default account of the mock (invented). */
export const MOCK_ACCOUNT: MockAccountOptions = {
  email: "river.tester@example.com",
  password: "invented-password-1",
  affiliateId: "20000001",
  givenName: "River",
  familyName: "Tester",
  affiliateTypeId: "1",
};

interface IssuedToken {
  account: MockAccount;
  exp: number;
  clientId: string;
}

interface RefreshGrant {
  account: MockAccount;
  method: "cognito" | "padi";
  clientId: string;
}

export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface GraphqlCall {
  mode: "proxy" | "direct";
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

function b64url(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

// ---------------------------------------------------------------------------------------------
// A small GraphQL parser (enough for the documents of the PADI web app)
// ---------------------------------------------------------------------------------------------

type Value = null | boolean | number | string | Value[] | { [key: string]: Value } | VarRef | EnumValue;

class VarRef {
  constructor(readonly name: string) {}
}

class EnumValue {
  constructor(readonly name: string) {}
}

export interface Field {
  alias?: string;
  name: string;
  args: Record<string, Value>;
  selection?: Field[];
}

export interface Operation {
  type: "query" | "mutation";
  name?: string;
  variables: string[];
  fields: Field[];
}

const PUNCT = new Set(["{", "}", "(", ")", ":", "[", "]", "!", "$", "="]);

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s|,/.test(ch)) {
      i++;
    } else if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (PUNCT.has(ch)) {
      tokens.push(ch);
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
    } else {
      const m = text.slice(i).match(/^[A-Za-z0-9_.+-]+/);
      if (!m) throw new Error(`Syntax Error: unexpected character "${ch}"`);
      tokens.push(m[0]);
      i += m[0].length;
    }
  }
  return tokens;
}

export function parseGraphql(text: string): Operation {
  const t = tokenize(text);
  let p = 0;
  const peek = () => t[p];
  const next = () => {
    const v = t[p++];
    if (v === undefined) throw new Error("Syntax Error: unexpected end of document");
    return v;
  };
  const expect = (v: string) => {
    const got = next();
    if (got !== v) throw new Error(`Syntax Error: expected "${v}", found "${got}"`);
  };

  const value = (): Value => {
    const tok = next();
    if (tok === "$") return new VarRef(next());
    if (tok === "[") {
      const items: Value[] = [];
      while (peek() !== "]") items.push(value());
      expect("]");
      return items;
    }
    if (tok === "{") {
      const obj: Record<string, Value> = {};
      while (peek() !== "}") {
        const key = next();
        expect(":");
        obj[key] = value();
      }
      expect("}");
      return obj;
    }
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    if (tok === "null") return null;
    if (tok === "true" || tok === "false") return tok === "true";
    if (/^-?\d/.test(tok)) return Number(tok);
    return new EnumValue(tok);
  };

  // A variable type: a name or a list, each maybe followed by "!".
  const type = (): void => {
    if (peek() === "[") {
      next();
      type();
      expect("]");
    } else {
      next();
    }
    if (peek() === "!") next();
  };

  const selection = (): Field[] => {
    expect("{");
    const fields: Field[] = [];
    while (peek() !== "}") {
      let name = next();
      let alias: string | undefined;
      if (peek() === ":") {
        next();
        alias = name;
        name = next();
      }
      const args: Record<string, Value> = {};
      if (peek() === "(") {
        next();
        while (peek() !== ")") {
          const key = next();
          expect(":");
          args[key] = value();
        }
        expect(")");
      }
      const field: Field = { name, args, ...(alias ? { alias } : {}) };
      if (peek() === "{") field.selection = selection();
      fields.push(field);
    }
    expect("}");
    return fields;
  };

  let kind: Operation["type"] = "query";
  let name: string | undefined;
  const variables: string[] = [];
  if (peek() === "query" || peek() === "mutation") {
    kind = next() as Operation["type"];
    if (peek() !== "{" && peek() !== "(") name = next();
    if (peek() === "(") {
      next();
      while (peek() !== ")") {
        expect("$");
        variables.push(next());
        expect(":");
        type();
        if (peek() === "=") {
          next();
          value();
        }
      }
      expect(")");
    }
  }
  const fields = selection();
  if (p !== t.length) throw new Error("Syntax Error: text after the operation");
  return { type: kind, ...(name ? { name } : {}), variables, fields };
}

/** Replace variable references with their values. Enum literals become strings. */
function resolve(v: Value, vars: Record<string, unknown>, declared: readonly string[]): unknown {
  if (v instanceof VarRef) {
    if (!declared.includes(v.name)) throw new MockGraphqlError("validation-failed", `variable "${v.name}" is not declared`);
    return vars[v.name] ?? null;
  }
  if (v instanceof EnumValue) return v.name;
  if (Array.isArray(v)) return v.map((x) => resolve(x, vars, declared));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, vars, declared)]));
  return v;
}

class MockGraphqlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Hasura-like evaluation on the store
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Does a row match a Hasura boolean expression? Relations are matched through `related`. */
function matches(row: Row, where: unknown, related: (row: Row, rel: string) => Row[] | Row | undefined): boolean {
  if (!where || typeof where !== "object") return true;
  for (const [key, cond] of Object.entries(where as Record<string, unknown>)) {
    if (key === "_and") {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((c) => matches(row, c, related))) return false;
    } else if (key === "_or") {
      if (!(cond as unknown[]).some((c) => matches(row, c, related))) return false;
    } else if (key === "_not") {
      if (matches(row, cond, related)) return false;
    } else {
      const rel = related(row, key);
      if (rel !== undefined) {
        const rows = Array.isArray(rel) ? rel : [rel];
        if (!rows.some((r) => matches(r, cond, related))) return false;
        continue;
      }
      const value = row[key];
      for (const [op, arg] of Object.entries(cond as Record<string, unknown>)) {
        // Hasura compares Int variables sent as strings as numbers.
        const want = typeof value === "number" && typeof arg === "string" && /^-?\d+(\.\d+)?$/.test(arg) ? Number(arg) : arg;
        const ok =
          op === "_eq" ? value === want :
          op === "_neq" ? value !== want :
          op === "_gt" ? value !== null && compare(value, want) > 0 :
          op === "_gte" ? value !== null && compare(value, want) >= 0 :
          op === "_lt" ? value !== null && compare(value, want) < 0 :
          op === "_lte" ? value !== null && compare(value, want) <= 0 :
          op === "_in" ? (want as unknown[]).includes(value) :
          op === "_is_null" ? (value === null || value === undefined) === want :
          op === "_ilike" ? typeof value === "string" && ilikeToRegExp(String(want)).test(value) :
          op === "_like" ? typeof value === "string" && ilikeToRegExp(String(want)).test(value) :
          undefined;
        if (ok === undefined) throw new MockGraphqlError("validation-failed", `unsupported operator ${op}`);
        if (!ok) return false;
      }
    }
  }
  return true;
}

const LOG_RELATIONS = new Set(["depth_times", "conditions", "equipment", "experiences", "skills"]);

function logRelated(row: Row, rel: string): Row[] | undefined {
  return LOG_RELATIONS.has(rel) ? ((row[rel] as Row[] | undefined) ?? []) : undefined;
}

/** Sort rows by a Hasura order_by (desc puts NULL first, asc puts it last, as in Postgres). */
function orderRows(rows: Row[], orderBy: unknown): Row[] {
  const terms = (Array.isArray(orderBy) ? orderBy : [orderBy]).filter(Boolean) as Array<Record<string, unknown>>;
  const keys: Array<{ get: (r: Row) => unknown; desc: boolean }> = [];
  for (const term of terms) {
    for (const [key, dir] of Object.entries(term)) {
      if (key.endsWith("_aggregate") && dir && typeof dir === "object") {
        const rel = key.replace(/_aggregate$/, "");
        for (const [fn, cols] of Object.entries(dir as Record<string, Record<string, string>>)) {
          for (const [col, d] of Object.entries(cols)) {
            keys.push({
              desc: String(d).startsWith("desc"),
              get: (r) => {
                const values = ((r[rel] as Row[] | undefined) ?? []).map((c) => c[col]).filter((v) => v !== null && v !== undefined) as number[];
                if (!values.length) return null;
                return fn === "max" ? Math.max(...values) : fn === "min" ? Math.min(...values) : values.reduce((a, b) => a + b, 0);
              },
            });
          }
        }
      } else {
        keys.push({ desc: String(dir).startsWith("desc"), get: (r) => r[key] });
      }
    }
  }
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const x = k.get(a);
      const y = k.get(b);
      const xn = x === null || x === undefined;
      const yn = y === null || y === undefined;
      if (xn || yn) {
        if (xn && yn) continue;
        // NULL is the largest value: first in a descending order, last in an ascending one.
        return (xn ? 1 : -1) * (k.desc ? -1 : 1);
      }
      const c = compare(x, y);
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  });
}

/** Keep the selected fields only (nested selections on relations). */
function project(value: unknown, selection: Field[] | undefined): unknown {
  if (!selection) return value === undefined ? null : structuredClone(value);
  if (Array.isArray(value)) return value.map((v) => project(v, selection));
  if (value === null || value === undefined) return null;
  const row = value as Row;
  const out: Row = {};
  for (const f of selection) {
    if (f.name === "__typename") {
      out[f.alias ?? f.name] = "object";
      continue;
    }
    if (!(f.name in row)) throw new MockGraphqlError("validation-failed", `field '${f.name}' not found in type`);
    out[f.alias ?? f.name] = project(row[f.name], f.selection);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The mock
// ---------------------------------------------------------------------------------------------

export class MockPadi {
  readonly accounts: MockAccount[];
  readonly clientId: string;
  idTokenTtlSec: number;
  /** Every request, in order. */
  readonly requests: MockRequest[] = [];
  /** Every GraphQL request, in order. */
  readonly graphql: GraphqlCall[] = [];
  /** Problems the mock saw in a client's requests (for example a query not scoped by affiliate_id). */
  readonly violations: string[] = [];
  /** The PADI auth API hands out a new refresh token on every refresh. */
  rotateRefreshTokens = false;
  /** The next password sign-in answers with this Cognito challenge. */
  challenge: string | undefined;
  /** HTTP answers to give once, by route ("cognito", "auth", "proxy", "direct", "instructor", "ecard", "images", "photo", "photo-storage"). */
  readonly failures = new Map<string, number[]>();
  /** Requests to hold until a test releases them, by route (see holdNext). */
  private readonly holds = new Map<string, Array<Promise<void>>>();
  /** Every pre-signed photo link handed out (a secret, like at PADI: it must never be logged). */
  readonly photoLinks: string[] = [];
  private readonly idTokens = new Map<string, IssuedToken>();
  /** Pre-signed photo links: the key in the path, and the signature the link must carry. */
  private readonly signedPhotos = new Map<string, { account: MockAccount; signature: string }>();
  private readonly refreshTokens = new Map<string, RefreshGrant>();
  private server: Server | undefined;
  url = "";

  constructor(opts: MockPadiOptions = {}) {
    this.clientId = opts.clientId ?? "mock-client-id";
    this.idTokenTtlSec = opts.idTokenTtlSec ?? 3600;
    const tz = opts.timeZone ?? "Europe/Zurich";
    this.accounts = (opts.accounts ?? [MOCK_ACCOUNT]).map((a) => ({
      email: a.email.toLowerCase(),
      password: a.password,
      affiliateId: a.affiliateId,
      givenName: a.givenName ?? "",
      familyName: a.familyName ?? "",
      affiliateTypeId: a.affiliateTypeId ?? "1",
      store: makeStore(a.affiliateId, a.seed ?? sampleDives, tz),
      photos: new Map(),
      certificationPhoto: a.certificationPhoto ?? { status: "NO_PHOTO" },
    }));
  }

  get account(): MockAccount {
    return this.accounts[0]!;
  }

  /**
   * The PADI_* operator overrides that point the server at this mock. With `photo`, also the
   * certification photo (without it, the server never asks for a photo).
   */
  env(opts: { photo?: boolean } = {}): Record<string, string> {
    return {
      ...(opts.photo ? { PADI_PHOTO_URL: `${this.url}/p/photos/web/certification` } : {}),
      PADI_COGNITO_URL: `${this.url}/cognito/`,
      PADI_AUTH_URL: `${this.url}/auth/api`,
      PADI_LOGBOOK_URL: `${this.url}/api/Logbook`,
      PADI_DIRECT_URL: `${this.url}/v1/graphql`,
      PADI_INSTRUCTOR_URL: `${this.url}/api/Logbook/instructor`,
      PADI_DIRECT_INSTRUCTOR_URL: `${this.url}/instructor`,
      PADI_ECARD_URL: `${this.url}/api/eCard`,
      PADI_IMAGES_URL: `${this.url}/api/Image`,
      PADI_CLIENT_ID: this.clientId,
    };
  }

  /** Answer the next request of a route with an HTTP status (once per call). */
  failNext(route: string, status: number): void {
    this.failures.set(route, [...(this.failures.get(route) ?? []), status]);
  }

  /**
   * The next request of a route waits until the returned function is called (once per call), so
   * a test can change things while the server waits for PADI.
   */
  holdNext(route: string): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.set(route, [...(this.holds.get(route) ?? []), gate]);
    return release;
  }

  /** Every ID token issued so far stops working (as if it expired). */
  expireIdTokens(): void {
    for (const t of this.idTokens.values()) t.exp = 0;
  }

  /** Every refresh token stops working (the user must sign in again). */
  revokeRefreshTokens(): void {
    this.refreshTokens.clear();
  }

  /** How many requests went to a path (prefix match). */
  count(pathPrefix: string): number {
    return this.requests.filter((r) => r.path.startsWith(pathPrefix)).length;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------------------------

  private issue(account: MockAccount, method: "cognito" | "padi", clientId: string, refreshToken?: string) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.idTokenTtlSec;
    const claims = {
      sub: `sub-${account.affiliateId}`,
      aud: clientId,
      iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_mock",
      token_use: "id",
      email: account.email,
      email_verified: true,
      given_name: account.givenName,
      family_name: account.familyName,
      "cognito:username": `user-${account.affiliateId}`,
      "custom:affiliate_id": account.affiliateId,
      "custom:affiliate_type_id": account.affiliateTypeId,
      iat: now,
      exp,
      jti: randomBytes(6).toString("hex"),
    };
    const idToken = `${b64url({ kid: "mock", alg: "RS256" })}.${b64url(claims)}.${randomBytes(32).toString("base64url")}`;
    const accessToken = `${b64url({ kid: "mock", alg: "RS256" })}.${b64url({ ...claims, token_use: "access", client_id: clientId })}.${randomBytes(32).toString("base64url")}`;
    this.idTokens.set(idToken, { account, exp, clientId });
    let rt = refreshToken;
    if (!rt) {
      // Shaped like a Cognito refresh token (an encrypted JWT with 5 parts).
      rt = [b64url({ cty: "JWT", enc: "A256GCM", alg: "RSA-OAEP" }), ...[0, 1, 2, 3].map(() => randomBytes(24).toString("base64url"))].join(".");
      this.refreshTokens.set(rt, { account, method, clientId });
    }
    return { idToken, accessToken, refreshToken: rt, exp };
  }

  /** The account of a valid bearer token, or the reason it is not valid. */
  private bearer(req: IncomingMessage): IssuedToken | "missing" | "expired" | "unknown" {
    const auth = String(req.headers.authorization ?? "");
    const m = auth.match(/^Bearer\s+(\S+)$/);
    if (!m) return "missing";
    const token = this.idTokens.get(m[1]!);
    if (!token) return "unknown";
    if (token.exp * 1000 <= Date.now()) return "expired";
    return token;
  }

  // -------------------------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    this.requests.push({ method: req.method ?? "", path, headers: { ...req.headers }, body });
    const route = routeOf(path);
    const hold = this.holds.get(route)?.shift();
    if (hold) await hold;
    const failure = this.failures.get(route)?.shift();
    try {
      if (failure) return send(res, failure, { message: `mock failure ${failure}` });
      if (route === "cognito" && req.method === "POST") return this.cognito(req, res, body);
      if (route === "auth" && req.method === "POST") return this.authApi(res, path, body);
      if ((route === "proxy" || route === "direct") && req.method === "POST") return this.graphqlRoute(req, res, route, body);
      if (route === "instructor" && req.method === "GET") return this.instructor(req, res, path);
      if (route === "ecard" && req.method === "GET") return this.ecard(req, res, path);
      if (route === "images" && req.method === "GET") return this.images(req, res, path);
      if (route === "photo" && req.method === "GET") return this.certificationPhoto(req, res, url);
      if (route === "photo-storage" && req.method === "GET") return this.photoStorage(req, res, url);
      send(res, 404, { message: "Not Found" });
    } catch (error) {
      send(res, 500, { message: (error as Error).message });
    }
  }

  private cognito(req: IncomingMessage, res: ServerResponse, body: string): void {
    if (req.headers["x-amz-target"] !== "AWSCognitoIdentityProviderService.InitiateAuth") {
      return send(res, 400, { __type: "UnknownOperationException", message: "Unknown operation" });
    }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/x-amz-json-1.1")) {
      return send(res, 400, { __type: "SerializationException", message: "Wrong content type" });
    }
    const input = JSON.parse(body) as { AuthFlow?: string; ClientId?: string; AuthParameters?: Record<string, string> };
    if (input.ClientId !== this.clientId) return send(res, 400, { __type: "ResourceNotFoundException", message: "User pool client does not exist." });
    const params = input.AuthParameters ?? {};
    if (input.AuthFlow === "USER_PASSWORD_AUTH") {
      // PADI usernames are lowercase: a mixed-case e-mail is a different (unknown) user.
      const account = this.accounts.find((a) => a.email === params.USERNAME && a.password === params.PASSWORD);
      if (!account) return send(res, 400, { __type: "NotAuthorizedException", message: "Incorrect username or password." });
      if (this.challenge) {
        const ChallengeName = this.challenge;
        this.challenge = undefined;
        return send(res, 200, { ChallengeName, Session: randomBytes(16).toString("base64url"), ChallengeParameters: {} });
      }
      const t = this.issue(account, "cognito", this.clientId);
      return send(res, 200, {
        AuthenticationResult: { AccessToken: t.accessToken, ExpiresIn: this.idTokenTtlSec, IdToken: t.idToken, RefreshToken: t.refreshToken, TokenType: "Bearer" },
        ChallengeParameters: {},
      });
    }
    if (input.AuthFlow === "REFRESH_TOKEN_AUTH") {
      const grant = params.REFRESH_TOKEN ? this.refreshTokens.get(params.REFRESH_TOKEN) : undefined;
      if (!grant) return send(res, 400, { __type: "NotAuthorizedException", message: "Invalid Refresh Token" });
      // A Cognito refresh does not return a refresh token (it does not rotate).
      const t = this.issue(grant.account, "cognito", this.clientId, params.REFRESH_TOKEN);
      return send(res, 200, { AuthenticationResult: { AccessToken: t.accessToken, ExpiresIn: this.idTokenTtlSec, IdToken: t.idToken, TokenType: "Bearer" }, ChallengeParameters: {} });
    }
    send(res, 400, { __type: "InvalidParameterException", message: `Unsupported AuthFlow ${input.AuthFlow}` });
  }

  private authApi(res: ServerResponse, path: string, body: string): void {
    const input = JSON.parse(body || "{}") as Record<string, string>;
    if (path.endsWith("/oauth/login")) {
      if (input.clientId !== this.clientId) return send(res, 400, { message: "Username/client id combination not found." });
      const account = this.accounts.find((a) => a.email === input.username && a.password === input.password);
      if (!account) return send(res, 400, { message: "Incorrect username or password." });
      const t = this.issue(account, "padi", input.clientId);
      return send(res, 200, { tokens: { idToken: t.idToken, accessToken: t.accessToken, refreshToken: t.refreshToken } });
    }
    if (path.endsWith("/oauth/refresh")) {
      const grant = input.refreshToken ? this.refreshTokens.get(input.refreshToken) : undefined;
      if (!grant) return send(res, 401, { message: "Invalid Refresh Token" });
      if (this.rotateRefreshTokens) {
        this.refreshTokens.delete(input.refreshToken!);
        const t = this.issue(grant.account, "padi", grant.clientId);
        return send(res, 200, { idToken: t.idToken, accessToken: t.accessToken, refreshToken: t.refreshToken });
      }
      const t = this.issue(grant.account, "padi", grant.clientId, input.refreshToken);
      return send(res, 200, { idToken: t.idToken, accessToken: t.accessToken, refreshToken: t.refreshToken });
    }
    send(res, 404, { message: "Not Found" });
  }

  private graphqlRoute(req: IncomingMessage, res: ServerResponse, mode: "proxy" | "direct", body: string): void {
    const auth = this.bearer(req);
    if (typeof auth === "string") {
      // The proxy (an API gateway) answers 401 with an empty body; Hasura answers invalid-jwt.
      if (mode === "proxy") {
        res.writeHead(401, { "www-authenticate": "Bearer", "content-length": "0" });
        return void res.end();
      }
      return send(res, 200, { errors: [{ extensions: { path: "$", code: "invalid-jwt" }, message: auth === "expired" ? "Could not verify JWT: JWTExpired" : "Could not verify JWT: JWSError" }] });
    }
    const account = auth.account;
    let input: { query?: string; variables?: Record<string, unknown> };
    try {
      input = JSON.parse(body) as typeof input;
    } catch {
      return send(res, 400, { message: "Invalid JSON" });
    }
    const variables = input.variables ?? {};
    this.graphql.push({ mode, query: input.query ?? "", variables, headers: { ...req.headers } });
    const headerAffiliate = req.headers["affiliate-id"];
    if (mode === "direct" && headerAffiliate !== undefined) this.violations.push("direct mode: the affiliate-id header must not be sent");
    if (mode === "proxy" && headerAffiliate !== undefined && String(headerAffiliate) !== account.affiliateId) {
      return send(res, 403, { message: "Forbidden" });
    }
    try {
      const op = parseGraphql(input.query ?? "");
      if (op.type === "mutation" && mode === "direct" && req.headers["x-hasura-role"] !== "user") {
        this.violations.push("direct mode: writes need x-hasura-role: user");
      }
      const data = this.execute(op, variables, account, mode);
      send(res, 200, { data });
    } catch (error) {
      if (error instanceof DemoPadiError) return send(res, 200, { errors: [{ extensions: { path: "$", code: error.code }, message: error.detail }] });
      if (error instanceof MockGraphqlError) return send(res, 200, { errors: [{ extensions: { path: "$", code: error.code }, message: error.message }] });
      return send(res, 200, { errors: [{ extensions: { path: "$", code: "parse-failed" }, message: (error as Error).message }] });
    }
  }

  /** Run one operation against the account's store (a mutation is one transaction). */
  private execute(op: Operation, vars: Record<string, unknown>, account: MockAccount, mode: "proxy" | "direct"): Record<string, unknown> {
    const store = account.store;
    const declared = op.variables;
    for (const name of Object.keys(vars)) {
      if (!declared.includes(name)) throw new MockGraphqlError("validation-failed", `unexpected variable "${name}"`);
    }
    const isUnits = op.fields.every((f) => f.name.includes("units_settings"));
    if ("affiliate_id" in vars) {
      if (mode === "direct" && !isUnits) this.violations.push("direct mode: $affiliate_id must not be sent");
      if (String(vars.affiliate_id) !== account.affiliateId) throw new MockGraphqlError("permission-error", "affiliate_id does not match the token");
    }
    const run = () => {
      const data: Record<string, unknown> = {};
      for (const field of op.fields) {
        const args = Object.fromEntries(Object.entries(field.args).map(([k, v]) => [k, resolve(v, vars, declared)]));
        data[field.alias ?? field.name] = this.rootField(field, args, account, mode, op.type);
      }
      return data;
    };
    return op.type === "mutation" ? store.transaction(run) : run();
  }

  private rootField(field: Field, args: Record<string, unknown>, account: MockAccount, mode: "proxy" | "direct", type: Operation["type"]): unknown {
    const store = account.store;
    const rows = () => [...store.logs.values()] as unknown as Row[];
    const scoped = (where: unknown) => {
      // The proxy needs an affiliate_id filter on every read of the user's dives.
      if (mode === "proxy" && !JSON.stringify(where ?? {}).includes('"affiliate_id"')) {
        this.violations.push(`proxy mode: ${field.name} is not filtered by affiliate_id`);
      }
    };
    const sel = field.selection;
    if (type === "query") {
      switch (field.name) {
        case "logbook_logs": {
          scoped(args.where);
          let list = rows().filter((r) => matches(r, args.where, logRelated));
          list = orderRows(list, args.order_by);
          const offset = Number(args.offset ?? 0);
          const limit = args.limit === null || args.limit === undefined ? undefined : Number(args.limit);
          list = list.slice(offset, limit === undefined ? undefined : offset + limit);
          return project(list, sel);
        }
        case "logbook_logs_aggregate": {
          scoped(args.where);
          const count = rows().filter((r) => matches(r, args.where, logRelated)).length;
          return project({ aggregate: { count } }, sel);
        }
        case "logbook_depth_time_aggregate": {
          scoped(args.where);
          const depth = rows().flatMap((log) => ((log.depth_times as Row[] | undefined) ?? []).map((d): Row => ({ ...d, log })));
          const related = (row: Row, rel: string) => (rel === "log" ? (row.log as Row) : undefined);
          const values = depth.filter((d) => matches(d, args.where, related)).map((d) => d.bottom_time).filter((v): v is number => typeof v === "number");
          return project({ aggregate: { sum: { bottom_time: values.length ? values.reduce((a, b) => a + b, 0) : null } } }, sel);
        }
        case "logbook_dive_site": {
          let sites = store.sites.filter((s) => matches(s as unknown as Row, args.where, () => undefined));
          if (args.limit !== undefined && args.limit !== null) sites = sites.slice(0, Number(args.limit));
          return project(sites, sel);
        }
        case "logbook_units_settings":
          return project([{ affiliate_id: Number(account.affiliateId), unit: store.units }], sel);
      }
      throw new MockGraphqlError("validation-failed", `field '${field.name}' not found in type: 'query_root'`);
    }

    // Mutations.
    const name = field.name;
    if (name === "insert_logbook_units_settings") {
      const objects = Array.isArray(args.objects) ? args.objects : [args.objects];
      for (const o of objects as Row[]) {
        if (String(o.affiliate_id) !== account.affiliateId) throw new MockGraphqlError("permission-error", "check constraint of an insert permission has failed");
        store.units = checkUnits(o.unit);
      }
      return project({ affected_rows: objects.length, returning: [{ affiliate_id: Number(account.affiliateId), unit: store.units }] }, sel);
    }
    const m = name.match(/^(insert|update|delete)_(logbook_[a-z_]+)$/);
    const table = m?.[2] as DemoTable | undefined;
    if (!m || !table || !(table === "logbook_logs" || table in CHILD_RELATION)) {
      throw new MockGraphqlError("validation-failed", `field '${name}' not found in type: 'mutation_root'`);
    }
    if (m[1] === "insert") {
      const objects = (Array.isArray(args.objects) ? args.objects : [args.objects]) as Row[];
      if (table === "logbook_logs") {
        let affected = 0;
        const returning: Row[] = [];
        for (const o of objects) {
          if (mode === "proxy" && o.affiliate_id === undefined) this.violations.push("proxy mode: insert without affiliate_id");
          const { id, affectedRows } = store.insertLog(o);
          affected += affectedRows;
          returning.push(store.logs.get(id) as unknown as Row);
        }
        return project({ affected_rows: affected, returning }, sel);
      }
      let affected = 0;
      for (const o of objects) affected += store.insertChild(table as Exclude<DemoTable, "logbook_logs">, o);
      return project({ affected_rows: affected, returning: [] }, sel);
    }
    const where = (args.where ?? {}) as Record<string, { _eq?: unknown }>;
    const key = table === "logbook_logs" ? "id" : "logs_id";
    const target = where[key]?._eq;
    if (target === undefined || Object.keys(where).length !== 1) throw new MockGraphqlError("validation-failed", `mock: ${name} must filter by ${key}`);
    const id = Number(target);
    const target2 = key === "id" ? { id } : { logs_id: id };
    if (m[1] === "update") {
      const affected = store.update(table, target2, (args._set ?? {}) as Row);
      return project({ affected_rows: affected, returning: [] }, sel);
    }
    const before =
      table === "logbook_logs"
        ? store.logs.has(id)
          ? [{ id }]
          : []
        : ((store.logs.get(id)?.[CHILD_RELATION[table as Exclude<DemoTable, "logbook_logs">]] ?? []) as unknown as Row[]).map((r) => ({ id: r.id }));
    const affected = store.delete(table, target2);
    return project({ affected_rows: affected, returning: before }, sel);
  }

  private instructor(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (typeof this.bearer(req) === "string") {
      res.writeHead(401, { "www-authenticate": "Bearer", "content-length": "0" });
      return void res.end();
    }
    const n = decodeURIComponent(path.split("/").pop() ?? "").trim();
    const pro = DEMO_INSTRUCTORS.find((p) => String(p.memberNumber) === n);
    // Unknown numbers come back as memberNumber -1 (as far as anyone knows).
    send(res, 200, { results: [pro ?? { memberNumber: -1, firstName: null, middleInitial: null, lastName: null }] });
  }

  private ecard(req: IncomingMessage, res: ServerResponse, path: string): void {
    const auth = this.bearer(req);
    if (typeof auth === "string") {
      res.writeHead(401, { "www-authenticate": "Bearer", "content-length": "0" });
      return void res.end();
    }
    const account = auth.account;
    const pro = account.affiliateTypeId === "2" || account.affiliateTypeId === "3";
    const op = path.split("/").pop();
    if (op !== (pro ? "GetAlleCardListPro" : "GeteCardListConsumer")) return send(res, 403, { message: "Forbidden" });
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const padiDate = (iso?: string) => (iso ? `${iso.slice(8, 10)}-${months[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : null);
    send(res, 200, {
      affiliateSummary: { affiliateID: Number(account.affiliateId), fullName: `${account.givenName} ${account.familyName}`.trim() },
      eCardInfo: account.store.certifications.map((c, i) => ({
        licenseID: c.licenseId ?? null,
        levelID: 100 + i,
        cardTitle: c.title,
        certDate: padiDate(c.certDate),
        padiNumber: c.padiNumber ?? null,
        instructorName: c.instructorName ?? null,
        instructorNumber: c.instructorNumber ?? null,
        storeName: c.storeName ?? null,
        eCardStockID: `mock-stock-${i + 1}`,
      })),
    });
  }

  private images(req: IncomingMessage, res: ServerResponse, path: string): void {
    const auth = this.bearer(req);
    if (typeof auth === "string") {
      res.writeHead(401, { "www-authenticate": "Bearer", "content-length": "0" });
      return void res.end();
    }
    const parts = path.split("/").filter(Boolean);
    const i = parts.indexOf("Image");
    const op = parts[i + 1];
    const logId = Number(parts[i + 2]);
    const photos = auth.account.photos.get(logId) ?? [];
    if (op === "GetImageList") return send(res, 200, photos.map((p) => p.id));
    if (op === "GetImage") {
      const photo = photos.find((p) => p.id === parts[i + 3]);
      if (!photo) return send(res, 404, { message: "Not Found" });
      res.writeHead(200, { "content-type": photo.mimeType, "content-length": String(photo.data.length) });
      return void res.end(photo.data);
    }
    send(res, 404, { message: "Not Found" });
  }

  /**
   * The certification photo, as the PADI website reads it: GET ...?status=approved answers
   * { preSignedURL, status, office }. An approved photo gets a new pre-signed link to the storage
   * host each time.
   */
  private certificationPhoto(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const auth = this.bearer(req);
    if (typeof auth === "string") {
      res.writeHead(401, { "www-authenticate": "Bearer", "content-length": "0" });
      return void res.end();
    }
    const account = auth.account;
    // The PADI web app sends this header with the photo request, and so does this server.
    if (req.headers["affiliate-id"] === undefined) this.violations.push("photo: no affiliate-id header");
    else if (req.headers["affiliate-id"] !== account.affiliateId) this.violations.push("photo: affiliate-id header of another account");
    if (url.searchParams.get("status") !== "approved") this.violations.push("photo: asked without status=approved");
    const photo = account.certificationPhoto;
    let link: string | null = null;
    if (photo.status === "APPROVED" && photo.data) {
      const key = randomBytes(8).toString("hex");
      const signature = randomBytes(16).toString("hex");
      this.signedPhotos.set(key, { account, signature });
      link = `${this.url}/photo-storage/certification/${key}.jpg?X-Amz-Expires=900&X-Amz-Signature=${signature}`;
      this.photoLinks.push(link);
    }
    send(res, 200, { preSignedURL: link, status: photo.status, office: "Mock Office" });
  }

  /** The storage host of the pre-signed links. Like S3, it refuses a request with another sign-in on top. */
  private photoStorage(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.headers.authorization !== undefined || req.headers["affiliate-id"] !== undefined || req.headers.cookie !== undefined) {
      this.violations.push("photo storage: request with a PADI token, an affiliate-id header or a cookie");
      return send(res, 400, { message: "Only one auth mechanism allowed" });
    }
    const key = url.pathname.match(/^\/photo-storage\/certification\/([0-9a-f]+)\.jpg$/)?.[1];
    const signed = key ? this.signedPhotos.get(key) : undefined;
    if (!signed || url.searchParams.get("X-Amz-Signature") !== signed.signature) return send(res, 403, { message: "AccessDenied" });
    const photo = signed.account.certificationPhoto;
    if (!photo.data) return send(res, 404, { message: "NoSuchKey" });
    res.writeHead(200, { "content-type": photo.type ?? "image/jpeg", "content-length": String(photo.data.length) });
    res.end(photo.data);
  }
}

function makeStore(affiliateId: string, seed: DemoSeed, timeZone: string): DemoLogbookStore {
  return new DemoLogbookStore({ seed, timeZone, affiliateId });
}

function routeOf(path: string): string {
  if (path.startsWith("/cognito")) return "cognito";
  if (path.startsWith("/auth/api/")) return "auth";
  if (path.startsWith("/api/Logbook/instructor/") || path.startsWith("/instructor/")) return "instructor";
  if (path === "/api/Logbook" || path === "/api/Logbook/") return "proxy";
  if (path === "/v1/graphql") return "direct";
  if (path.startsWith("/api/eCard/")) return "ecard";
  if (path.startsWith("/api/Image/")) return "images";
  if (path === "/p/photos/web/certification") return "photo";
  if (path.startsWith("/photo-storage/")) return "photo-storage";
  return "other";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}

/** Start a mock PADI API on a free local port. */
export async function startMockPadi(opts: MockPadiOptions = {}): Promise<MockPadi> {
  return new MockPadi(opts).start();
}
