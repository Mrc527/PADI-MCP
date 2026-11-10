/**
 * The PADI hosts this server talks to, and the public app client it signs in with.
 *
 * Every value can be changed by the operator through the environment (for tests against a local
 * mock PADI API), never by users: users cannot point the server at another host.
 */

import { ConfigError } from "../util/errors.js";

export interface PadiEndpoints {
  /** AWS Cognito endpoint: POST here with X-Amz-Target (InitiateAuth). */
  cognitoUrl: string;
  /** PADI auth API base: <authUrl>/oauth/login and <authUrl>/oauth/refresh. */
  authUrl: string;
  /** Logbook GraphQL proxy ("proxy" API mode): POST here. */
  logbookUrl: string;
  /** Direct Hasura GraphQL endpoint ("direct" API mode): POST here. */
  directUrl: string;
  /** Instructor lookup base in proxy mode: GET <instructorUrl>/<member number>. */
  instructorUrl: string;
  /** Instructor lookup base in direct mode: GET <directInstructorUrl>/<member number>. */
  directInstructorUrl: string;
  /** eCard API base: GET <ecardUrl>/GeteCardListConsumer (or GetAlleCardListPro). */
  ecardUrl: string;
  /** Dive photos API base: GET <imagesUrl>/GetImageList/<logId>, <imagesUrl>/GetImage/<logId>/<imageId>. */
  imagesUrl: string;
  /**
   * The diver's certification photo (the profile photo of the PADI website): GET
   * <photoUrl>?status=approved. Absent when the operator points the other PADI addresses
   * somewhere else (a mock) but not this one: then the real PADI is never asked for a photo.
   */
  photoUrl?: string;
  /** Public Cognito app client (no secret). */
  clientId: string;
  /** AWS region of the Cognito user pool. */
  region: string;
}

export const DEFAULT_ENDPOINTS: Readonly<PadiEndpoints> = Object.freeze({
  cognitoUrl: "https://cognito-idp.us-west-2.amazonaws.com/",
  authUrl: "https://api.global-prod.padi.com/auth/api",
  logbookUrl: "https://logbook.global-prod.padi.com/api/Logbook",
  directUrl: "https://divelog.global-prod.padi.com/v1/graphql",
  instructorUrl: "https://logbook.global-prod.padi.com/api/Logbook/instructor",
  directInstructorUrl: "https://dive-log-service.global-prod.padi.com/instructor",
  ecardUrl: "https://ecard.global-prod.padi.com/api/eCard",
  imagesUrl: "https://logbook-images-api.padi.com/api/Image",
  photoUrl: "https://api.padi.com/p/photos/web/certification",
  clientId: "2arn5r23p0ugce89a5moe95v1l",
  region: "us-west-2",
});

/** The environment variable that overrides each endpoint (operator only). */
export const ENDPOINT_ENV: Readonly<Record<keyof PadiEndpoints, string>> = Object.freeze({
  cognitoUrl: "PADI_COGNITO_URL",
  authUrl: "PADI_AUTH_URL",
  logbookUrl: "PADI_LOGBOOK_URL",
  directUrl: "PADI_DIRECT_URL",
  instructorUrl: "PADI_INSTRUCTOR_URL",
  directInstructorUrl: "PADI_DIRECT_INSTRUCTOR_URL",
  ecardUrl: "PADI_ECARD_URL",
  imagesUrl: "PADI_IMAGES_URL",
  photoUrl: "PADI_PHOTO_URL",
  clientId: "PADI_CLIENT_ID",
  region: "PADI_COGNITO_REGION",
});

type UrlKey = Exclude<keyof PadiEndpoints, "clientId" | "region">;

const URL_KEYS: readonly UrlKey[] = [
  "cognitoUrl",
  "authUrl",
  "logbookUrl",
  "directUrl",
  "instructorUrl",
  "directInstructorUrl",
  "ecardUrl",
  "imagesUrl",
  "photoUrl",
];

function checkUrl(name: string, value: string, keepTrailingSlash: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError(`${name} must be an http or https URL`);
  if (url.username || url.password) throw new ConfigError(`${name} must not contain a user name or password`);
  if (url.search || url.hash) throw new ConfigError(`${name} must not contain a query or fragment`);
  return keepTrailingSlash ? url.href : url.href.replace(/\/+$/, "");
}

/**
 * The endpoints with the operator's overrides from the environment. Without overrides, the
 * production PADI hosts. When only PADI_COGNITO_REGION is set, the Cognito URL follows the region.
 * When other PADI addresses are overridden (a mock) but PADI_PHOTO_URL is not, there is no photo
 * address, so nothing is sent to the real PADI.
 */
export function endpointsFromEnv(env: Record<string, string | undefined> = process.env): PadiEndpoints {
  const get = (key: keyof PadiEndpoints) => env[ENDPOINT_ENV[key]]?.trim() || undefined;

  const region = get("region") ?? DEFAULT_ENDPOINTS.region;
  if (!/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(region)) {
    throw new ConfigError(`PADI_COGNITO_REGION is not an AWS region: "${region}"`);
  }
  const clientId = get("clientId") ?? DEFAULT_ENDPOINTS.clientId;
  if (!/^[A-Za-z0-9_+-]{1,128}$/.test(clientId)) throw new ConfigError("PADI_CLIENT_ID contains characters a client id cannot have");

  const out: PadiEndpoints = { ...DEFAULT_ENDPOINTS, clientId, region };
  if (get("region") && !get("cognitoUrl")) out.cognitoUrl = `https://cognito-idp.${region}.amazonaws.com/`;
  for (const key of URL_KEYS) {
    const value = get(key);
    // The Cognito endpoint is a full address (POST to it as it is); the others are bases.
    if (value) out[key] = checkUrl(ENDPOINT_ENV[key], value, key === "cognitoUrl");
  }
  if (!get("photoUrl") && URL_KEYS.some((key) => get(key))) delete out.photoUrl;
  return out;
}

/**
 * Names of the endpoints that differ from the production defaults (for diagnostics). A photo
 * address left out because of other overrides is not one of them.
 */
export function customEndpoints(endpoints: PadiEndpoints): string[] {
  return (Object.keys(DEFAULT_ENDPOINTS) as (keyof PadiEndpoints)[])
    .filter((key) => endpoints[key] !== undefined && endpoints[key] !== DEFAULT_ENDPOINTS[key])
    .map((key) => ENDPOINT_ENV[key]);
}

/** The environment variables of the endpoints that are set, for passing operator overrides on. */
export function endpointEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.values(ENDPOINT_ENV)) {
    const value = env[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}
