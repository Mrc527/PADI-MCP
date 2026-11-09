# The PADI logbook API (unofficial notes)

PADI has **no public API**. The PADI online logbook at https://learning.padi.com/logbook talks to a
private backend. This page lists what is known about that backend, so that MCP for PADI can sign
in as the user's own account and read and change the user's own dives.

Nothing here is official, and PADI can change any of it at any time.

The facts come from two kinds of sources:

- the JavaScript that `learning.padi.com`, `account.padi.com` and `www.padi.com` send to every
  visitor (read, never run), and
- what earlier open-source tools showed about requests and answers. No code was taken from them.

Labels used below:

- **seen working**: a real answer or a captured request shows it.
- **web app**: this is what the current PADI web app sends. It very likely works, but this
  project has not seen it work yet.
- **not verified yet**: a guess, or something that only one tool did. Treat with care.

All sample values on this page (ids, numbers, names, places) are invented.

## Contents

1. [Hosts](#1-hosts)
2. [Sign-in](#2-sign-in)
3. [Logbook API](#3-logbook-api)
4. [Dive record](#4-dive-record)
5. [Quirks checklist](#5-quirks-checklist)
6. [eCards and other endpoints](#6-ecards-and-other-endpoints)
7. [Errors and rate limits](#7-errors-and-rate-limits)
8. [What MCP for PADI does](#8-what-mcp-for-padi-does)
9. [Open questions](#9-open-questions)

---

## 1. Hosts

| Host | Purpose |
| --- | --- |
| `cognito-idp.us-west-2.amazonaws.com` | AWS Cognito, the identity provider behind PADI accounts |
| `api.global-prod.padi.com` | PADI auth API, `/auth/api/*` (sign-in, refresh, password) |
| `logbook.global-prod.padi.com` | Logbook GraphQL **proxy** `/api/Logbook` and the proxy instructor lookup `/api/Logbook/instructor/{n}`. Behind AWS API Gateway. |
| `divelog.global-prod.padi.com` | **Direct** Hasura GraphQL endpoint `/v1/graphql` (web app) |
| `dive-log-service.global-prod.padi.com` | Instructor lookup `/instructor/{n}` used with the direct endpoint (web app) |
| `logbook-images-api.padi.com` | Dive photos `/api/Image/*` (web app) |
| `ecard.global-prod.padi.com` | eCards `/api/eCard/*` |
| `account.padi.com` | The PADI sign-in pages |
| `learning.padi.com` | The PADI web app (logbook pages) |

Both GraphQL endpoints answer with the same schema. The web app on `learning.padi.com` uses the
direct endpoint today; on other hosts it still uses the proxy. The proxy is older and was used by
every known tool until mid 2026. It still answers (HTTP 401 without a token).

---

## 2. Sign-in

### 2.1 Identity provider and app clients

- AWS Cognito user pool `us-west-2_hGwJiwtcI` in region `us-west-2` (from the `iss` claim of a real
  token; **seen working**).
- PADI accounts use public app clients **without a client secret**, so no `SECRET_HASH` is needed.
- No multi-factor sign-in has been seen on PADI accounts. Sign-in may still ask for an extra step
  some day (see the open questions).

App client ids:

| Client id | Used by | Notes |
| --- | --- | --- |
| `2arn5r23p0ugce89a5moe95v1l` | www.padi.com single sign-on; earlier tools | `USER_PASSWORD_AUTH` and `REFRESH_TOKEN_AUTH` **seen working** with it, and its tokens work with the logbook proxy. MCP for PADI uses this one. |
| `7l7c6rgndimr802cfhva7akdsh` | the current learning.padi.com app | Whether its tokens work with both logbook endpoints is **not verified yet**. |
| `15esf6sqlsmtsibqq1rmdb158i` | default of account.padi.com | Staging: `s8ad7osu52idg2o5dk750eph7` on `api-stage.global-np.padi.com`. |

The token's `aud` claim is the client id it was issued for. The web app refreshes with
`clientId = aud` of the stored token.

### 2.2 Method A: Cognito `USER_PASSWORD_AUTH` (seen working)

```
POST https://cognito-idp.us-west-2.amazonaws.com/
Content-Type: application/x-amz-json-1.1
X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth

{"AuthFlow":"USER_PASSWORD_AUTH","ClientId":"2arn5r23p0ugce89a5moe95v1l",
 "AuthParameters":{"USERNAME":"<e-mail, lowercased>","PASSWORD":"<password>"}}
```

account.padi.com lowercases the e-mail before it signs in. Do the same.

Success (HTTP 200):

```json
{"AuthenticationResult":{"AccessToken":"...","ExpiresIn":3600,"IdToken":"...","RefreshToken":"...","TokenType":"Bearer"},
 "ChallengeParameters":{}}
```

Errors (HTTP 400, `{"__type":"...","message":"..."}`):

| `__type` | Meaning |
| --- | --- |
| `NotAuthorizedException`, message `Incorrect username or password.` | wrong e-mail or password. **Never try again by yourself**: repeated failures can lock the account. |
| `NotAuthorizedException`, message `Password attempts exceeded` | too many failures; wait |
| `UserNotConfirmedException` | the account was never confirmed |
| `PasswordResetRequiredException` | PADI wants a new password |
| `InvalidParameterException` | for example the flow is not enabled for the client |

An answer with a `ChallengeName` (for example `SOFTWARE_TOKEN_MFA` or `NEW_PASSWORD_REQUIRED`)
instead of `AuthenticationResult` needs a step this kind of client cannot do.

### 2.3 Method B: PADI auth API (web app)

This is what account.padi.com uses.

```
POST https://api.global-prod.padi.com/auth/api/oauth/login
Content-Type: application/json

{"username":"<e-mail, lowercased>","password":"<password>","clientId":"<client id>","extraData":""}
```

- Success: HTTP 200 with `{"tokens":{"idToken":"...","accessToken":"...","refreshToken":"..."}}`.
  Other fields are unknown.
- Errors: the web app reads the error body as **text** and looks for `User is not confirmed` and
  `Incorrect username or password`. Another tool read a JSON body with `message`. The exact format
  and status codes are **not verified yet** (Q5).
- In the browser, account.padi.com then redirects to
  `<redirect_uri>?id_token=<idToken>&refresh_token=<refreshToken>`, and the target app keeps
  `accessToken = idToken`.

### 2.4 Refresh

**Cognito `REFRESH_TOKEN_AUTH`** (seen working). Same endpoint and headers as 2.2:

```json
{"AuthFlow":"REFRESH_TOKEN_AUTH","ClientId":"<aud>","AuthParameters":{"REFRESH_TOKEN":"<refresh token>"}}
```

- Success returns `AuthenticationResult` with a new `IdToken` and `AccessToken`, but **no new
  refresh token**. The refresh token does not rotate: keep the stored one.
- Failure: HTTP 400 `NotAuthorizedException`, message `Invalid Refresh Token` or
  `Refresh Token has expired`.

**PADI auth API** (web app):

```
POST https://api.global-prod.padi.com/auth/api/oauth/refresh
Content-Type: application/json

{"refreshToken":"<refresh token>","clientId":"<aud of the ID token>","idToken":"<current ID token, optional>"}
```

- Answer: `{"idToken":"...","accessToken":"...","refreshToken":"..."}`. Whether `refreshToken` is
  new or the same one is **not verified yet** (Q3), so a client must save it when it changes.

When the web app refreshes:

- after any HTTP 401, and on the direct endpoint after a GraphQL error with
  `extensions.code == "invalid-jwt"`. It then sends the request again, once;
- not before the token expires. A server client should refresh shortly before expiry anyway.

### 2.5 Tokens and claims

- **The bearer token is the Cognito ID token** (RS256 JWT) for every logbook, photo and eCard
  request: `Authorization: Bearer <ID token>`.
- ID token lifetime: **3600 s** (`exp - iat`; `ExpiresIn` 3600; seen working).
- Refresh token lifetime: unknown (Cognito's default is 30 days; Q4).
- Claims used:
  - `custom:affiliate_id`: the user's PADI affiliate id, a numeric string such as `"10000001"`.
    This is the tenant key of every logbook query. **Always take it from the token, never from
    user input.**
  - `custom:affiliate_type_id`: `"2"` or `"3"` means a PADI Pro.
  - `given_name`, `family_name`, `email`: for display.
  - `aud`: the app client; `exp`, `iat`, `iss`, `sub`.
  - Others seen: `cognito:username`, `email_verified`, `phone_number_verified`, `preferred_username`,
    `middle_name`, `birthdate`, `gender`, `global_uuid`, `contact_id`, `custom:language`,
    `custom:delegate`.

### 2.6 Headers per endpoint

| Header | Proxy `/api/Logbook` | Direct `/v1/graphql` | Photos | eCards |
| --- | --- | --- | --- | --- |
| `Authorization: Bearer <ID token>` | required (seen working: 401 without it) | required (web app) | required (web app) | required (seen working: 401 without it) |
| `affiliate-id: <custom:affiliate_id>` | sent by the web app; one tool left it out and worked, so probably optional | **not sent**: the web app removes it | sent, except on `GetImage` | sent by the web app; some tools leave it out |
| `x-platform: web` | sent by the web app; probably optional | sent | no | no |
| `x-hasura-role: user` | no | sent **on writes** (web app) | no | no |
| `Content-Type: application/json` | yes | yes | multipart for uploads | (GET) |

`Origin` and `Referer` are not needed by server clients (some tools never send them). CORS
preflights simply echo the asked headers, so they say nothing about which headers are required.
No `x-api-key` is used by any logbook call.

---

## 3. Logbook API

### 3.1 Transport

Both endpoints speak GraphQL over HTTP POST: `{"query": "...", "variables": {...}}`. The backend is
**Hasura** on Postgres (Hasura names such as `insert_*`, `_set`, `_ilike`, `*_aggregate`,
`on_conflict`, and Hasura error codes).

| | Proxy | Direct |
| --- | --- | --- |
| URL | `https://logbook.global-prod.padi.com/api/Logbook` | `https://divelog.global-prod.padi.com/v1/graphql` |
| Extra headers | `affiliate-id`, `x-platform: web` | `x-platform: web`, `x-hasura-role: user` on writes |
| Row scoping | every query takes `$affiliate_id` and filters `where: {affiliate_id: {_eq: $affiliate_id}}` | **no** `$affiliate_id` and no filter: Hasura scopes rows by the token (inferred from the web app) |
| Write check | none | the web app treats `affected_rows == 0` on `insert/update/delete_logbook_logs`, and an empty `returning` on the units upsert, as an error |
| Auth errors | HTTP 401 with an empty body | HTTP 401, or HTTP 200 with a GraphQL error `invalid-jwt` |

Variables: the web app sends `Int` variables as JSON strings (for example `"10000001"`); tools send
numbers. Hasura accepts both (seen working).

### 3.2 Data model

```
logbook_logs                (id, affiliate_id, log_type, log_course, log_number, dive_type, dive_title,
                             dive_date, dive_location, memsys_member_number, status, adventure_dive,
                             created_date, update_date)
 |- depth_times  -> logbook_depth_time   (id, logs_id, max_depth, bottom_time, time_in, time_out)
 |- conditions   -> logbook_conditions   (id, logs_id, water_type, body_of_water, weather, air_temp,
 |                                        surface_water_temp, bottom_water_temp, visibility,
 |                                        visibility_distance, wave_condition, current, surge)
 |- equipment    -> logbook_equipment    (id, logs_id, suit_type, weight, weight_type,
 |                                        additional_equipment text[], cylinder_type, cylinder_size,
 |                                        gas_mixture, oxygen, nitrogen, helium, starting_pressure,
 |                                        ending_pressure)
 |- experiences  -> logbook_experience   (id, logs_id, feeling, notes, buddies, dive_center)
 '- skills       -> logbook_skills       (id, logs_id, dive_skills text[])
logbook_dive_site          (id, name)            site name suggestions only
logbook_units_settings     (affiliate_id, unit)  primary key constraint "units_settings_pkey"
```

- Relation names are irregular: `depth_times` and `experiences` are plural, `conditions`,
  `equipment` and `skills` are as shown. All five are **array** relations: read item `[0]`.
- The reverse relation from `logbook_depth_time` to the dive is `log`.
- `depth_times_aggregate` exists on `logbook_logs` and is used for sorting.
- **No cascade**: deleting a `logbook_logs` row that still has child rows fails with a foreign key
  error (`conditions_logs_id_fkey`; seen working).
- Postgres enum type names: `log_type`, `status`, `units`, `dive_type`, `suit`, `gas_mixture`,
  `currents` (plural), `surge`. Whether `water_type`, `body_of_water`, `weather`, `visibility`,
  `wave_condition`, `weight_type`, `cylinder_type` and `feeling` are enums or text is
  **not verified yet** (Q8).

### 3.3 Operations

The texts below are what the web app sends. Answers come as `{"data": {...}}` or
`{"errors": [...]}` (section 7).

#### List dives

Proxy:

```graphql
query logbook_logs($affiliate_id: Int!, $limit: Int, $offset: Int) {
  logbook_logs(where: { affiliate_id: { _eq: $affiliate_id } }, order_by: { dive_date: desc, id: desc },
               limit: $limit, offset: $offset) {
    id log_type log_course log_number dive_title dive_date dive_location status
  }
}
```

- Filtered variants add `$log_type: log_type` with `log_type: { _eq: $log_type }`, or
  `$status: status` with `status: { _eq: $status }`. The web app uses one of them, never both.
- Direct: the same three queries without `$affiliate_id` and without the `where` part for it.
- `order_by` is written into the query text. Default `{ dive_date: desc, id: desc }`; deepest or
  longest first: `{ depth_times_aggregate: { max: { max_depth: desc } } }` (or `bottom_time`).
  The web app always sorts descending. Its direct client only allows a fixed list of columns.
- Paging is `limit`/`offset`. The web app shows 15 per page (7 on phones). `limit: null` returns
  every dive. No server maximum is known (Q10).
- More fields can be selected in the same query (MCP for PADI adds
  `dive_type depth_times { max_depth bottom_time }`, or every field for an export). Extra
  `where` filters (date range, text) are **not verified yet** (Q9).

Answer (seen working; values invented):

```json
{"data":{"logbook_logs":[
  {"id":1000124,"log_type":"Recreational","log_course":null,"log_number":0,"dive_title":"House Reef ",
   "dive_date":"2026-03-22T00:00:00","dive_location":"Coral Bay","status":"Pending"},
  {"id":1000101,"log_type":"Training","log_course":"Advanced","log_number":5,
   "dive_title":"Adventure Dive - Deep","dive_date":"2025-12-18T00:00:00","dive_location":"Blue Wall","status":"Verified"}]}}
```

#### Count dives

```graphql
query logbook_logs_aggregate($affiliate_id: Int!) {
  logbook_logs_aggregate(where: { affiliate_id: { _eq: $affiliate_id } }) { aggregate { count } }
}
```

Filtered variants as for the list. Direct: `query logbook_logs_aggregate { logbook_logs_aggregate { aggregate { count } } }`.
Answer: `{"data":{"logbook_logs_aggregate":{"aggregate":{"count":26}}}}` (seen working).

#### Total bottom time

```graphql
query logbook_depth_time_aggregate($affiliate_id: Int!) {
  logbook_depth_time_aggregate(where: { log: { affiliate_id: { _eq: $affiliate_id } } }) {
    aggregate { sum { bottom_time } }
  }
}
```

Direct: without `$affiliate_id` and `where`. The answer is in minutes, or `null`. Other aggregates
(`max`, `avg`) are **not verified yet**.

#### Get one dive

```graphql
query logbook_logs($affiliate_id: Int!, $id: Int!) {
  logbook_logs(where: { affiliate_id: { _eq: $affiliate_id }, _and: { id: { _eq: $id } } }) {
    id log_type log_course log_number dive_type dive_title dive_date dive_location
    memsys_member_number status adventure_dive
    depth_times { max_depth bottom_time time_in time_out }
    skills { dive_skills }
    conditions { water_type body_of_water weather air_temp surface_water_temp bottom_water_temp
                 visibility visibility_distance wave_condition current surge }
    equipment { suit_type weight weight_type additional_equipment cylinder_type cylinder_size
                gas_mixture oxygen nitrogen helium starting_pressure ending_pressure }
    experiences { feeling notes buddies dive_center }
  }
}
```

Direct: `query logbook_logs($id: Int!)` with `where: { _and: { id: { _eq: $id } } }`. The answer
is a list; an empty list means "no such dive, or not yours".

Answer (seen working; values invented). Numbers come back as JSON numbers, and
`memsys_member_number` is a **number**:

```json
{"data":{"logbook_logs":[{"id":1000123,"log_type":"Recreational","log_course":null,"log_number":null,
 "dive_type":"BeachShore","dive_title":"House Reef ","dive_date":"2026-03-21T00:00:00","dive_location":"Coral Bay",
 "memsys_member_number":123456,"status":"Verified","adventure_dive":null,
 "depth_times":[{"max_depth":10.0,"bottom_time":29,"time_in":null,"time_out":null}],
 "skills":[],
 "conditions":[{"water_type":"Fresh","body_of_water":"Lake","weather":"Sunny","air_temp":10.0,
   "surface_water_temp":null,"bottom_water_temp":6.0,"visibility":"Average","visibility_distance":null,
   "wave_condition":"NoWaves","current":"NoCurrent","surge":null}],
 "equipment":[{"suit_type":"DrySuit","weight":13.0,"weight_type":"Heavy","additional_equipment":[],
   "cylinder_type":"Steel","cylinder_size":15.0,"gas_mixture":"Air","oxygen":21,"nitrogen":79,"helium":0,
   "starting_pressure":210.0,"ending_pressure":150.0}],
 "experiences":[{"feeling":"Good","notes":"","buddies":"Sam Example","dive_center":"Example Divers"}]}]}}
```

#### Dive site suggestions

Same text on both endpoints:

```graphql
query logbook_logs($name: String!) { logbook_dive_site(where: { name: { _ilike: $name } }) { id name } }
```

- `$name` is an SQL `LIKE` pattern; the web app sends `"%<typed text>%"`. No limit is sent.
- The chosen site is stored only as **free text** in `dive_location`; the site id is never stored.
  Any other text is accepted too.

#### Create a dive (nested insert)

```graphql
mutation insert_logbook_logs($general: [logbook_logs_insert_input!]!) {
  insert_logbook_logs(objects: $general) {
    affected_rows
    returning { id affiliate_id dive_title dive_type dive_location log_type log_course
                dive_date created_date status adventure_dive }
  }
}
```

On the direct endpoint the operation is named `insert_divelog`; the rest is the same.

- `$general` is sent as a **single object**, although it is declared as a list (Hasura accepts it).
- Child rows are nested as `{"data": {...}}`.
- The web app puts `affiliate_id` (from the token) into `general` on both endpoints.
- Recreational payload as the web app builds it (values invented):

```json
{"general": {
  "affiliate_id": "10000001",
  "log_type": "Recreational", "log_course": null, "log_number": null,
  "created_date": "2026-11-09T19:40:00", "update_date": "2026-11-09T19:40:00",
  "dive_type": "BeachShore", "dive_title": "Reef", "dive_location": "Coral Bay", "dive_date": "11/09/2026",
  "status": "Publish",
  "memsys_member_number": null,
  "depth_times":  {"data": {"bottom_time": "42", "max_depth": "28"}},
  "conditions":   {"data": {"water_type": "Salt", "body_of_water": "Ocean", "weather": "Partly Cloudy",
                   "air_temp": "30.000", "surface_water_temp": "29.000", "bottom_water_temp": "27.000",
                   "visibility": "High", "visibility_distance": "20.000", "wave_condition": "SmallWaves",
                   "current": "SomeCurrent", "surge": null}},
  "equipment":    {"data": {"starting_pressure": "200", "ending_pressure": "60", "suit_type": "Shorty",
                   "weight": "4", "weight_type": "Good", "additional_equipment": "{Hood,Boots}",
                   "cylinder_type": "Aluminum", "cylinder_size": "11.1", "gas_mixture": "Enriched_32",
                   "oxygen": "32", "nitrogen": "68", "helium": "0"}},
  "experiences":  {"data": {"feeling": "Amazing", "notes": "...", "buddies": "Sam", "dive_center": "Example Divers"}}
}}
```

- A **training** dive also nests `"skills": {"data": {"dive_skills": "{\"no skills\"}"}}` and sets
  `log_type: "Training"`, `log_course`, `log_number` and `adventure_dive`.
- `created_date` and `update_date` are **UTC** wall clock without a zone (`YYYY-MM-DDTHH:mm:ss`).
- `time_in` and `time_out` are never written by the web app.
- Answer: `{"data":{"insert_logbook_logs":{"affected_rows":5,"returning":[{"id":1000125,...}]}}}`.
  Take `returning[0].id`. (`affected_rows` probably counts the child rows too.)
- Some tools create in two steps (the dive first, then the child rows with `logs_id`). A failure
  between the steps leaves a dive without child rows, so dives with missing child rows exist.

#### Update a dive

Recreational, same text on both endpoints:

```graphql
mutation UpdateRecreationalDiveLog($id: Int!, $general: logbook_logs_set_input!,
  $depthTime: logbook_depth_time_set_input!, $conditions: logbook_conditions_set_input!,
  $equipment: logbook_equipment_set_input!, $experience: logbook_experience_set_input!) {
  update_logbook_logs(where: { id: { _eq: $id } }, _set: $general) { affected_rows }
  update_logbook_depth_time(where: { logs_id: { _eq: $id } }, _set: $depthTime) { affected_rows }
  update_logbook_conditions(where: { logs_id: { _eq: $id } }, _set: $conditions) { affected_rows }
  update_logbook_equipment(where: { logs_id: { _eq: $id } }, _set: $equipment) { affected_rows }
  update_logbook_experience(where: { logs_id: { _eq: $id } }, _set: $experience) { affected_rows }
}
```

Training dives:

- with skills: the same plus `$skills: logbook_skills_set_input!` and
  `update_logbook_skills(where: { logs_id: { _eq: $id } }, _set: $skills) { affected_rows }`. On the
  proxy the text keeps the name `UpdateRecreationalDiveLog`; on the direct endpoint it is
  `UpdateTrainingDiveLog`;
- without skills: `UpdateTrainingDiveLogWithoutSkills`, otherwise like the recreational text.

Variables:

- `general`: `{affiliate_id, log_course, log_number, update_date, dive_type, dive_title,
  dive_location, dive_date "MM/DD/YYYY", status, memsys_member_number, adventure_dive}`. Before
  sending, the web app **removes `log_type`**, turns an empty status into `"Draft"` and turns
  `"Resubmit"` into `"Pending"`. `created_date` is never sent again. The recreational form sends
  `adventure_dive: null`, which erases a value another app may have stored.
- `depthTime`: `{bottom_time, max_depth}`. `time_in` and `time_out` are not sent, so stored values
  stay.
- `conditions`, `equipment`, `experience`: **every column, every time**. A column left out is
  written as null by the web app, so a client must read the dive, merge the change and write all
  columns.
- Answer: one `affected_rows` per table. A dive that does not exist or is not yours gives 0.
- An update does **not** create a missing child row (`affected_rows` 0 for that table). A robust
  client inserts the missing row instead (**not verified yet**, Q16).

#### Delete a dive

One document; child tables first, then the dive:

```graphql
mutation delete_logbook_logs($id: Int!) {
  delete_logbook_depth_time(where: { logs_id: { _eq: $id } }) { affected_rows }
  delete_logbook_skills(where: { logs_id: { _eq: $id } }) { affected_rows }
  delete_logbook_conditions(where: { logs_id: { _eq: $id } }) { affected_rows }
  delete_logbook_experience(where: { logs_id: { _eq: $id } }) { affected_rows }
  delete_logbook_equipment(where: { logs_id: { _eq: $id } }) { affected_rows }
  delete_logbook_logs(where: { id: { _eq: $id } }) { affected_rows }
}
```

- The proxy text declares `$id: Int` (nullable) and adds `returning { id }` to each part.
- The web app deletes the dive's photos first.
- There is **no soft delete**. `Draft` is a real, visible status, not a "deleted" marker.
- Whether the server refuses to delete or change verified dives is **not verified yet** (Q12).

#### Units setting

```graphql
query logbook_units_settings($affiliate_id: Int!) {
  logbook_units_settings(where: { affiliate_id: { _eq: $affiliate_id } }) { affiliate_id unit }
}
```

Direct: `query logbook_units_settings { logbook_units_settings { affiliate_id unit } }`.

Write (both endpoints, with `$affiliate_id`):

```graphql
mutation insert_logbook_units_settings($affiliate_id: Int!, $unit: units!) {
  insert_logbook_units_settings(objects: { affiliate_id: $affiliate_id, unit: $unit },
    on_conflict: { constraint: units_settings_pkey, update_columns: unit }) {
    returning { affiliate_id unit }
  }
}
```

Values `"Metric"` or `"Imperial"`; no row means `"Metric"`. The setting only changes what the web
app shows: **stored values are always metric**.

### 3.4 REST endpoints around the logbook

#### Instructor (PADI Pro) lookup (web app)

| | Direct | Proxy |
| --- | --- | --- |
| URL | `GET https://dive-log-service.global-prod.padi.com/instructor/{memberNumber}` | `GET https://logbook.global-prod.padi.com/api/Logbook/instructor/{memberNumber}` |

Headers: `Authorization`, `affiliate-id`, `x-platform: web`. Answer:
`{"results":[{"memberNumber":123456,"firstName":"Pat","middleInitial":"Q","lastName":"Instructor"}]}`.
The web app shows the name as `first middle last`, and treats the number as unknown when the
request fails, `results` is empty, or `memberNumber` is below 0. What an unknown number returns
exactly is **not verified yet** (Q18).

#### Dive photos (web app, not verified yet)

Base `https://logbook-images-api.padi.com/api/Image`, `Authorization: Bearer <ID token>`:

| Operation | Request | Notes |
| --- | --- | --- |
| List | `GET /GetImageList/{logId}` | a JSON list of image ids |
| Get | `GET /GetImage/{logId}/{imageId}` | binary; sent without `affiliate-id` |
| Upload | `POST /UploadImage/{logId}` | `multipart/form-data` with `image` and `logId`; the web app mentions 5 MB and 10 MB limits |
| Delete | `DELETE /DeleteImage/{logId}/{imageId}` | |

### 3.5 Status and verification

| Value | Meaning |
| --- | --- |
| `Publish` | logged without verification (seen working) |
| `Draft` | saved as a draft; depth and time may be missing (seen working) |
| `Pending` | sent to a PADI Pro for verification (seen working) |
| `Resubmit` | the Pro sent it back; the web app saves it as `Pending` again |
| `Verified` | verified by the Pro (seen working) |
| `QR Code Verified` | verified with a QR code (note the spaces) |

- **Verification**: set `memsys_member_number` to the Pro's member number and save with
  `status: "Pending"`. The web app first checks the number with the instructor lookup. The Pro
  verifies outside this API. There is no signature image.
- Values the enum refuses (seen working): `Trash`, `Deleted`, `Archived`, `Archive`, `Hidden`,
  `Private`, `Public`, `Active`, `Inactive`.
- The web app makes general, depth/time and skills fields **read-only** while the status is
  `Pending`, `Verified` or `QR Code Verified`. Whether the server enforces this is unknown (Q12).

### 3.6 Training dives

| `log_course` | Course | `log_number` and title |
| --- | --- | --- |
| `Open` | Open Water Diver | 1-4: "Open Water Training Dive 1" to "4" |
| `Advanced` | Advanced Open Water | 5 "Adventure Dive - Deep", 6 "Adventure Dive - Navigation", 7, 8, 9 "Adventure Elective Dive 1" to "3" |
| `Rescue` | Rescue Diver | 10, 11 "Open Water Rescue Scenario 1" and "2" |
| `DSD` | Discover Scuba Diving | 12 "Discover Scuba Diving" |
| `Reactivate` | ReActivate | 13 "ReActivate" |
| `SpecialtyAndDistinctive` | Specialty / Distinctive | no number (the web app sends `null`; older data has `0`); free title |

- The title is set from the course (except Specialty).
- The instructor's member number is required for training dives.
- **Adventure elective dives (7-9)** need `adventure_dive`, one of: Deep Diving, Underwater
  Navigation, Altitude Diving, Boat Diving, Digital Underwater Imaging, Drift Diving, Dry Suit
  Diving, Fish Identification, Night Diving, Peak Performance Buoyancy, Search and Recovery,
  Rescue, Underwater Naturalist, Wreck Diving, Adaptive Support Diver, Cavern Diving, Delayed
  Surface Marker Buoy Dive, Dive Against Debris Diver (AWARE), Diver Propulsion Vehicle (DPV),
  Enriched Air Diver, Full Face Mask Diver, Ice Diver, Rebreather Diver, Self-Reliant Diver, Shark
  Conservation Dive(AWARE), Sidemount Diver (exact spellings).
- **Skills** (`dive_skills`, a `text[]`):
  - `Open`, `Rescue`, `Reactivate`: at least one of `"no skills"`, `"cramp removal"`,
    `"snorkel exchange"`, `"tube deployment"`, `"weight drop"`, `"swim compass"`, `"diver tow"`,
    `"remove scuba"`, `"remove weights"`, plus `"controlled ascent"` and `"compass navigation"`
    for every dive except Open Water dive 1.
  - `Rescue` exercises: `"tired diver"`, `"panicked diver"`, `"responsive diver"`,
    `"distressed diver underwater"`, `"missing diver"`, `"surfacing the unresponsive diver"`,
    `"unresponsive diver at the surface"`, `"exiting the unresponsive diver"`,
    `"first aid for pressure"`, `"unresponsive diver"`.
  - Specialty: one free-text entry (for example `["Dry suit"]`).
  - Other courses store no skills.
- The web app hides training dives that are already logged (same course and number), except
  Specialty and ReActivate.

### 3.7 Things that do not exist

No source shows dive profiles or samples, GPS positions, a dive computer import, buddy accounts
or signatures, an export endpoint, or a site database beyond `id` and `name`.

### 3.8 Web links

On `https://learning.padi.com`:

- `/logbook`
- `/logbook/log-dive/recreational/create`
- `/logbook/log-dive/recreational/update/{logId}`
- `/logbook/log-dive/select-course`
- `/logbook/log-dive/training/create/{course}/{logNumber}/{title}`
- `/logbook/log-dive/training/update/{logId}`

---

## 4. Dive record

Values are case-sensitive. "Web app values" are the choices the PADI form offers.

### 4.1 `logbook_logs`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | int | about 8 digits, ascending over time |
| `affiliate_id` | int | from the token's `custom:affiliate_id`; never from the user |
| `log_type` | enum `log_type` | `Recreational`, `Training`; never sent in an update |
| `log_course` | text or enum | section 3.6; null for recreational dives |
| `log_number` | int | 1-13 (section 3.6); recreational: null (some apps store 0) |
| `dive_type` | enum `dive_type` | `Boat`, `BeachShore` (label "Shore"), `Other`. Refused (seen working): `Shore`, `ShoreDive`, `Beach`, `Pool`, `Cave`, `Ice`, `Night`, `Drift`, `Wreck` |
| `dive_title` | text | trailing spaces are kept as typed |
| `dive_date` | naive timestamp | read `YYYY-MM-DDTHH:MM:SS`, write **`MM/DD/YYYY`** (section 4.6). Web app range: today minus 100 years to today |
| `dive_location` | text | free text |
| `memsys_member_number` | int | the PADI Pro's member number; read as a number, written as text by the web app |
| `status` | enum `status` | section 3.5 |
| `adventure_dive` | text | section 3.6 |
| `created_date`, `update_date` | timestamp | UTC wall clock `YYYY-MM-DDTHH:mm:ss`; not selected by the web app |

### 4.2 `logbook_depth_time`

| Field | Unit | Notes |
| --- | --- | --- |
| `max_depth` | m | 0-999999; required unless Draft |
| `bottom_time` | minutes | whole minutes, 0-999999; required unless Draft |
| `time_in`, `time_out` | ? | never written by the web app; format unknown (Q7) |

### 4.3 `logbook_conditions`

| Field | Unit | Web app values |
| --- | --- | --- |
| `water_type` | | `Salt`, `Fresh` |
| `body_of_water` | | `Ocean`, `Lake`, `Quarry`, `River`, `Other` |
| `weather` | | `Sunny`, `Partly Cloudy` (with a space), `Cloudy`, `Rainy`, `Windy`, `Foggy` |
| `air_temp`, `surface_water_temp`, `bottom_water_temp` | degrees C | the web app sends 3 decimals |
| `visibility` | | `High`, `Average`, `Low` |
| `visibility_distance` | m | |
| `wave_condition` | | `NoWaves`, `SmallWaves`, `MediumWaves`, `LargeWaves` |
| `current` | enum `currents` | `NoCurrent`, `SomeCurrent` (label "Light"), `MediumCurrent`, `StrongCurrent`. Refused: `LightCurrent`, `LowCurrent`, `HighCurrent`, `BigCurrent` |
| `surge` | enum `surge` | `SomeSurge` (light), `MediumSurge`, `BigSurge` (strong). No "none" choice: none is `null`. `NoSurge` is accepted by the API but not offered. Refused: `LightSurge`, `StrongSurge`, `LowSurge`, `HighSurge` |

Clicking a selected choice again in the web app sends `null`.

### 4.4 `logbook_equipment`

| Field | Unit | Web app values and notes |
| --- | --- | --- |
| `suit_type` | | `NoExposure`, `FullSuit_3mm`, `FullSuit_5mm`, `FullSuit_7mm`, `Shorty`, `SemiDrySuit`, `DrySuit`. Refused (seen working): `None`, `FullSuit3mm`, `SemiDry`, `Wetsuit`, `Dry`, `Drysuit`, `Full`, `FullSuit`, `Skin`, `DiveSkin`, `Bare`, `BoardShorts`, `Swimsuit` |
| `weight` | kg | |
| `weight_type` | | `Light`, `Good`, `Heavy` |
| `additional_equipment` | `text[]` | web app choices `Hood`, `Gloves`, `Boots`; other text is accepted. **Read** as a JSON list. **Write** as a Postgres array literal string: `"{Hood,Gloves}"`, `'{"Dive light"}'`, `"{}"` or `null`. A JSON list fails (`parse-failed: A string is expected for type: _text`), a bare string fails (`malformed array literal`). Quote items with commas, spaces, quotes, backslashes or braces. |
| `cylinder_type` | | `Steel`, `Aluminum` (US spelling), `Other` |
| `cylinder_size` | litres | the web app converts cubic feet to litres plainly (not a tank rating) |
| `gas_mixture` | enum `gas_mixture` | `Air`, `Enriched_32`, `Enriched_36`, `Enriched_40`, `Enriched` (custom), `Trimix`, `Rebreather`. `Nitrox` and `Heliox` are accepted by the API but not offered. Refused: `Nitrox32`, `EAN`, `EANx`, `O2`, `Oxygen`, `Argon` |
| `oxygen`, `nitrogen`, `helium` | % (int) | presets: Air 21/79/0, `Enriched_32` 32/68/0, `_36` 36/64/0, `_40` 40/60/0. Other mixes are typed in. Web app rule: with a gas set, the three must add up to 100. **The API does not check this.** |
| `starting_pressure`, `ending_pressure` | bar | "pressure used" is only computed by the web app |

### 4.5 `logbook_experience` and `logbook_skills`

| Field | Notes |
| --- | --- |
| `feeling` | `Amazing`, `Good`, `Average`, `Poor` |
| `notes` | free text; new lines kept; maximum length unknown (Q13) |
| `buddies` | **one** free-text string |
| `dive_center` | free text |
| `dive_skills` | `text[]`, section 3.6; written like `additional_equipment` |

### 4.6 Units, dates and times

- Stored values are **always metric**: depth and visibility in m, temperatures in degrees C,
  weight in kg, cylinder size in litres, pressures in bar, bottom time in minutes. The web app
  converts imperial input with 3 decimals before it writes.
- `dive_date`: write `MM/DD/YYYY`; read `YYYY-MM-DDTHH:MM:SS` and keep the date part only (some
  older dives carry a time of day). No time zone conversion: it is a calendar date. ISO dates on
  write are **not verified yet** (Q14).
- `created_date`, `update_date`: UTC wall clock without a zone.
- There is no time zone field anywhere.

---

## 5. Quirks checklist

1. Take the affiliate id from the token, never from the caller.
2. The five child relations are lists: read `[0]`; rows may be missing.
3. Numbers may be sent as strings; they come back as numbers. Accept both on read.
4. `memsys_member_number` comes back as a number.
5. An update overwrites `conditions`, `equipment` and `experience` completely: read, merge, write.
   Keep `adventure_dive` unless it changes.
6. Never send `log_type` in an update.
7. Delete the child rows first, then the dive, in one mutation.
8. Enum values are exact: `BeachShore`, `SomeCurrent`, `BigSurge`, `FullSuit_5mm`, `SemiDrySuit`,
   `Enriched_32`, `Partly Cloudy`, `QR Code Verified`.
9. `text[]` columns are written as Postgres array literal strings.
10. Keep the gas and its percentages consistent (sum 100); the server does not check.
11. Pending, Verified and QR Code Verified dives are read-only in the web app.
12. On the direct endpoint, `affected_rows == 0` is a failure and `invalid-jwt` means "refresh".

---

## 6. eCards and other endpoints

### 6.1 eCards (`ecard.global-prod.padi.com`)

`GET` with `Authorization: Bearer <ID token>`:

| Endpoint | For |
| --- | --- |
| `/api/eCard/GeteCardListConsumer` | divers: every eCard and an `affiliateSummary` (seen working) |
| `/api/eCard/GetAlleCardListPro` | PADI Pros (`custom:affiliate_type_id` 2 or 3) |
| `/api/eCard/GetCardListConsumer`, `/GetAllCardListPro` | printed card lists |
| `/api/eCard/GeteCardTopConsumer/{n}`, `/GeteCardTopPro/{n}` | the top n eCards |

Fields seen:

- `affiliateSummary.affiliateID` (the same as `custom:affiliate_id`), `affiliateSummary.fullName`
- `eCardInfo[]`: `licenseID`, `levelID`, `cardTitle`, `certDate` (`DD-MMM-YYYY`, for example
  `14-SEP-2024`), `inWaterDate` (`MM/DD/YYYY`), `padiNumber`, `instructorName`,
  `instructorNumber`, `storeName`, `storeAddressLine1`, `storeAddressLine2`, `storePhoneNumber`,
  `eCardStockID`, and some payment fields.
- Card image:
  `https://res.cloudinary.com/padi/image/upload/f_auto/q_auto/f_auto/q_auto/CDN/global/ecards/<eCardStockID>.jpg`.
- Without a token: HTTP 401 with an empty body.

### 6.2 Others (web app, not used, not verified yet)

- `GET https://api.pro-prod.padi.com/certifications/me`: certifications (`items` with `certId`,
  `certName`, `credentialName`, `stockId`, ...).
- `GET https://learning-prod.padi.com/profiles/{affiliateId}`: profile.
- `POST https://api.pro-prod.padi.com/participants/pros/graphql`, query
  `memberInfo(query:{number})`: a Pro by member number.

---

## 7. Errors and rate limits

**HTTP.** The proxy and the eCard API sit behind AWS API Gateway (`apigw-requestid` header). A
missing or bad token gives HTTP 401 with an empty body and `www-authenticate: Bearer`.

**GraphQL (Hasura).** Errors come back as HTTP 200:

```json
{"errors":[{"extensions":{"path":"$","code":"<code>"},"message":"<text>"}]}
```

| Code | Example message |
| --- | --- |
| `data-exception` | `invalid input value for enum dive_type: "Shore"`, `malformed array literal: "Camera"` |
| `parse-failed` | `A string is expected for type: _text` |
| `constraint-violation` (code not verified yet) | `... violates foreign key constraint "conditions_logs_id_fkey"` |
| `invalid-jwt` | the token was refused (direct endpoint) |
| `validation-failed` | unknown field (standard Hasura; not seen yet) |

**Cognito**: HTTP 400 `{"__type":"...Exception","message":"..."}`.
**PADI auth API**: error body as text or JSON (Q5).

**Rate limits.** None are documented and none were seen. Tools pace bulk reads at about one request
per second. Serialise writes, and back off on HTTP 429 and 5xx.

---

## 8. What MCP for PADI does

- **Sign-in**: Cognito `USER_PASSWORD_AUTH` with client `2arn5r23p0ugce89a5moe95v1l` and the
  e-mail lowercased; with `PADI_LOGIN_METHOD=auto` it tries the PADI auth API only when Cognito
  fails for another reason than wrong credentials. It never tries again after "wrong e-mail or
  password". Only the refresh token is kept.
- **Tokens**: the ID token is the bearer token. It is refreshed when less than 120 s remain, and
  once after an HTTP 401 or `invalid-jwt`, the same way it was issued. A new refresh token from
  the PADI auth API is saved.
- **Transport** (`PADI_API_MODE`): `proxy` (default), `direct`, or `auto` (proxy first; switch to
  direct after two proxy answers of 404, 410 or 5xx in a row, or a 401 right after a refresh).
  Direct mode is **not verified yet** against the live service.
- **Writes**: one at a time per user; read, merge and write on updates; missing child rows are
  inserted; delete is the single ordered mutation; locked dives are refused; a dive is sent for
  verification only after the instructor lookup found the Pro.
- **Requests**: 20 s timeout, at most 3 tries with backoff on 429, 5xx and network errors. A write
  is never sent again once it may have reached PADI.
- **Not done**: photos are not deleted together with a dive (there is no photo delete in this
  server yet), and photos cannot be uploaded.

---

## 9. Open questions

These need a real account to answer. Write tests should use a dive dated before 1950, with a
title starting with `MCPTEST_`, and remove it afterwards.

1. **Q1 Token audience.** Which `aud` does each sign-in path give, and are both client ids
   accepted by the proxy **and** by the direct endpoint?
2. **Q2 Direct endpoint.** Can a server use `divelog.global-prod.padi.com/v1/graphql`? Is
   `x-hasura-role: user` required? Does it refuse the `affiliate-id` header or an `affiliate_id`
   variable? Does it accept `log_type` in an update (write)? The same for the
   `dive-log-service` instructor lookup.
3. **Q3** Does `/oauth/refresh` return a new or the same refresh token? Does Cognito
   `REFRESH_TOKEN_AUTH` still not rotate it?
4. **Q4** How long does a refresh token live? Do a password change or a sign-out revoke it? Does
   the `/oauth/login` answer include `expiresIn`?
5. **Q5** The exact error body and status codes of `/oauth/login` for a wrong password, an
   unconfirmed user and a locked account. Can sign-in ask for a code or a captcha?
6. **Q6** Does the proxy need `affiliate-id`, `x-platform`, `Origin` or `Referer`?
7. **Q7** Type and format of `time_in` and `time_out`; can they be written (write); how does the
   web app show them?
8. **Q8** Are `weather`, `water_type`, `body_of_water`, `visibility`, `wave_condition`,
   `weight_type`, `cylinder_type` and `feeling` enums or text? Is `PartlyCloudy` accepted (write)?
   GraphQL introspection may answer this without a write.
9. **Q9** Which extra `where` filters and `order_by` directions are allowed (date range, title
   `_ilike`, ascending)?
10. **Q10** Is there a server maximum for `limit`, or a size cap? What are the rate limits?
11. **Q11** Does the proxy check ownership when the `affiliate_id` in the variables or header
    differs from the token? (Security relevant; only test with the user's own second account.)
12. **Q12** Can a Pending, Verified or QR Code Verified dive be changed or deleted through the API
    (write)?
13. **Q13** Maximum lengths of `notes`, `dive_title` and `buddies`. (UTF-8 text works.)
14. **Q14** Does `dive_date` accept `YYYY-MM-DD` on write? How does the mobile app write a dive
    date with a time of day (local time or UTC)?
15. **Q15** Photos API: the exact answer of `GetImageList`, allowed formats and sizes, and whether
    the headers are the same as for GraphQL.
16. **Q16** Does an update of a missing child row need an insert (write)?
17. **Q17** `NoSurge`, `Nitrox` and `Heliox` are accepted by the API: how do the web and mobile
    apps show them?
18. **Q18** The full answer of the instructor lookup, and what an unknown number returns.
