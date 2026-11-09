/**
 * The GraphQL documents of the PADI logbook, as the PADI web app sends them (docs/padi-api.md
 * section 3). Each read has two texts:
 * - "proxy" (the logbook API gateway): every query takes $affiliate_id and filters on it;
 * - "direct" (the Hasura endpoint): no $affiliate_id and no filter (Hasura scopes rows by the
 *   token).
 *
 * The list selection can be extended with dive_type and depth_times (one query for summaries
 * with depth and time) or with every field (export and statistics).
 */

import type { ChildTable, DiveStatus, LogType } from "../logbook/types.js";

export type ResolvedMode = "proxy" | "direct";

export interface GraphqlDocument {
  query: string;
  variables: Record<string, unknown>;
}

/** The columns of the PADI list query. */
export const SUMMARY_FIELDS = "id log_type log_course log_number dive_title dive_date dive_location status";

/** Extra columns for summaries with depth and time. */
export const DEPTH_FIELDS = "dive_type depth_times { max_depth bottom_time }";

/** Every column of a dive, as in the PADI "get one dive" query. */
export const FULL_FIELDS = [
  "id log_type log_course log_number dive_type dive_title dive_date dive_location",
  "memsys_member_number status adventure_dive",
  "depth_times { max_depth bottom_time time_in time_out }",
  "skills { dive_skills }",
  "conditions { water_type body_of_water weather air_temp surface_water_temp bottom_water_temp visibility visibility_distance wave_condition current surge }",
  "equipment { suit_type weight weight_type additional_equipment cylinder_type cylinder_size gas_mixture oxygen nitrogen helium starting_pressure ending_pressure }",
  "experiences { feeling notes buddies dive_center }",
].join(" ");

export type Selection = "summary" | "depth" | "full";

function fields(selection: Selection): string {
  if (selection === "full") return FULL_FIELDS;
  if (selection === "depth") return `${SUMMARY_FIELDS} ${DEPTH_FIELDS}`;
  return SUMMARY_FIELDS;
}

export type OrderKey = "date" | "max_depth" | "bottom_time";

/** The order_by object the PADI web app inlines into the query text. Always descending. */
export function orderBy(key: OrderKey = "date"): string {
  if (key === "max_depth" || key === "bottom_time") return `{ depth_times_aggregate: { max: { ${key}: desc } } }`;
  return "{ dive_date: desc, id: desc }";
}

/** The affiliate id as a GraphQL Int (a number when it fits, as KA and FX send it). */
export function affiliateVar(affiliateId: string): number | string {
  const n = Number(affiliateId);
  return Number.isSafeInteger(n) ? n : affiliateId;
}

export interface ListDocOptions {
  limit: number | null;
  offset: number;
  logType?: LogType;
  status?: DiveStatus;
  order?: OrderKey;
  selection: Selection;
}

/** List dives. PADI filters by log_type or by status, never both (log_type wins). */
export function listDocument(mode: ResolvedMode, affiliateId: string, o: ListDocOptions): GraphqlDocument {
  const filter = o.logType ? "log_type" : o.status ? "status" : undefined;
  const params: string[] = [];
  const where: string[] = [];
  const variables: Record<string, unknown> = { limit: o.limit, offset: o.offset };
  if (mode === "proxy") {
    params.push("$affiliate_id: Int!");
    where.push("affiliate_id: { _eq: $affiliate_id }");
    variables.affiliate_id = affiliateVar(affiliateId);
  }
  if (filter === "log_type") {
    params.push("$log_type: log_type");
    where.push("log_type: { _eq: $log_type }");
    variables.log_type = o.logType;
  } else if (filter === "status") {
    params.push("$status: status");
    where.push("status: { _eq: $status }");
    variables.status = o.status;
  }
  params.push("$limit: Int", "$offset: Int");
  const whereArg = where.length ? `where: { ${where.join(", ")} }, ` : "";
  const query = `query logbook_logs(${params.join(", ")}) { logbook_logs(${whereArg}order_by: ${orderBy(o.order)}, limit: $limit, offset: $offset) { ${fields(o.selection)} } }`;
  return { query, variables };
}

/** Count dives, optionally by log_type or by status. */
export function countDocument(mode: ResolvedMode, affiliateId: string, filter: { logType?: LogType; status?: DiveStatus } = {}): GraphqlDocument {
  const params: string[] = [];
  const where: string[] = [];
  const variables: Record<string, unknown> = {};
  if (mode === "proxy") {
    params.push("$affiliate_id: Int!");
    where.push("affiliate_id: { _eq: $affiliate_id }");
    variables.affiliate_id = affiliateVar(affiliateId);
  }
  if (filter.logType) {
    params.push("$log_type: log_type");
    where.push("log_type: { _eq: $log_type }");
    variables.log_type = filter.logType;
  } else if (filter.status) {
    params.push("$status: status");
    where.push("status: { _eq: $status }");
    variables.status = filter.status;
  }
  const head = params.length ? `query logbook_logs_aggregate(${params.join(", ")})` : "query logbook_logs_aggregate";
  const args = where.length ? `(where: { ${where.join(", ")} })` : "";
  return { query: `${head} { logbook_logs_aggregate${args} { aggregate { count } } }`, variables };
}

/** Sum of bottom_time over the user's dives. */
export function totalBottomTimeDocument(mode: ResolvedMode, affiliateId: string): GraphqlDocument {
  if (mode === "direct") {
    return { query: "query logbook_depth_time_aggregate { logbook_depth_time_aggregate { aggregate { sum { bottom_time } } } }", variables: {} };
  }
  return {
    query:
      "query logbook_depth_time_aggregate($affiliate_id: Int!) { logbook_depth_time_aggregate(where: { log: { affiliate_id: { _eq: $affiliate_id } } }) { aggregate { sum { bottom_time } } } }",
    variables: { affiliate_id: affiliateVar(affiliateId) },
  };
}

/** One dive with every field. The answer is an array (empty: no such dive, or not the user's). */
export function getDocument(mode: ResolvedMode, affiliateId: string, id: number): GraphqlDocument {
  if (mode === "direct") {
    return { query: `query logbook_logs($id: Int!) { logbook_logs(where: { _and: { id: { _eq: $id } } }) { ${FULL_FIELDS} } }`, variables: { id } };
  }
  return {
    query: `query logbook_logs($affiliate_id: Int!, $id: Int!) { logbook_logs(where: { affiliate_id: { _eq: $affiliate_id }, _and: { id: { _eq: $id } } }) { ${FULL_FIELDS} } }`,
    variables: { affiliate_id: affiliateVar(affiliateId), id },
  };
}

/** The PADI dive site list (same text in both modes). `name` is an SQL LIKE pattern. */
export function siteSearchDocument(name: string): GraphqlDocument {
  return { query: "query logbook_logs($name: String!) { logbook_dive_site(where: { name: { _ilike: $name } }) { id name } }", variables: { name } };
}

/** Insert a dive with its child rows (nested insert). The operation name differs by mode. */
export function insertDocument(mode: ResolvedMode, general: Record<string, unknown>): GraphqlDocument {
  const name = mode === "direct" ? "insert_divelog" : "insert_logbook_logs";
  return {
    query: `mutation ${name}($general: [logbook_logs_insert_input!]!) { insert_logbook_logs(objects: $general) { affected_rows returning { id affiliate_id dive_title dive_type dive_location log_type log_course dive_date created_date status adventure_dive } } }`,
    variables: { general },
  };
}

const UPDATE_PARAMS =
  "$id: Int!, $general: logbook_logs_set_input!, $depthTime: logbook_depth_time_set_input!, $conditions: logbook_conditions_set_input!, $equipment: logbook_equipment_set_input!, $experience: logbook_experience_set_input!";
const UPDATE_BODY = [
  "update_logbook_logs(where: { id: { _eq: $id } }, _set: $general) { affected_rows }",
  "update_logbook_depth_time(where: { logs_id: { _eq: $id } }, _set: $depthTime) { affected_rows }",
  "update_logbook_conditions(where: { logs_id: { _eq: $id } }, _set: $conditions) { affected_rows }",
  "update_logbook_equipment(where: { logs_id: { _eq: $id } }, _set: $equipment) { affected_rows }",
  "update_logbook_experience(where: { logs_id: { _eq: $id } }, _set: $experience) { affected_rows }",
].join(" ");
const SKILLS_UPDATE = "update_logbook_skills(where: { logs_id: { _eq: $id } }, _set: $skills) { affected_rows }";

export type UpdateKind = "recreational" | "training" | "training_without_skills";

/**
 * Update a dive and its child rows. The PADI proxy text of a training update with skills keeps the
 * name UpdateRecreationalDiveLog; the direct text is named UpdateTrainingDiveLog.
 */
export function updateDocument(mode: ResolvedMode, kind: UpdateKind, variables: Record<string, unknown>): GraphqlDocument {
  if (kind === "training") {
    const name = mode === "direct" ? "UpdateTrainingDiveLog" : "UpdateRecreationalDiveLog";
    return { query: `mutation ${name}(${UPDATE_PARAMS}, $skills: logbook_skills_set_input!) { ${UPDATE_BODY} ${SKILLS_UPDATE} }`, variables };
  }
  const name = kind === "training_without_skills" ? "UpdateTrainingDiveLogWithoutSkills" : "UpdateRecreationalDiveLog";
  return { query: `mutation ${name}(${UPDATE_PARAMS}) { ${UPDATE_BODY} }`, variables };
}

/** The Hasura table of each child relation. */
export const CHILD_TABLES: Readonly<Record<ChildTable, string>> = Object.freeze({
  depth_times: "logbook_depth_time",
  conditions: "logbook_conditions",
  equipment: "logbook_equipment",
  experiences: "logbook_experience",
  skills: "logbook_skills",
});

/** Insert child rows that a dive does not have yet (each object carries logs_id). */
export function insertChildrenDocument(rows: Partial<Record<ChildTable, Record<string, unknown>>>): GraphqlDocument {
  const params: string[] = [];
  const body: string[] = [];
  const variables: Record<string, unknown> = {};
  for (const [rel, row] of Object.entries(rows) as Array<[ChildTable, Record<string, unknown> | undefined]>) {
    if (!row) continue;
    const table = CHILD_TABLES[rel];
    params.push(`$${rel}: [${table}_insert_input!]!`);
    body.push(`insert_${table}(objects: $${rel}) { affected_rows }`);
    variables[rel] = [row];
  }
  return { query: `mutation insert_missing_rows(${params.join(", ")}) { ${body.join(" ")} }`, variables };
}

/**
 * Delete a dive: the 5 child tables by logs_id first, then the log (there is no cascade). One
 * document, as the PADI web app sends it.
 */
export function deleteDocument(mode: ResolvedMode, id: number): GraphqlDocument {
  const proxy = mode === "proxy";
  const ret = proxy ? " returning { id }" : "";
  const children = ["logbook_depth_time", "logbook_skills", "logbook_conditions", "logbook_experience", "logbook_equipment"]
    .map((t) => `delete_${t}(where: { logs_id: { _eq: $id } }) { affected_rows${ret} }`)
    .join(" ");
  return {
    query: `mutation delete_logbook_logs($id: Int${proxy ? "" : "!"}) { ${children} delete_logbook_logs(where: { id: { _eq: $id } }) { affected_rows${ret} } }`,
    variables: { id },
  };
}

/** Read the PADI logbook display setting. */
export function unitsDocument(mode: ResolvedMode, affiliateId: string): GraphqlDocument {
  if (mode === "direct") return { query: "query logbook_units_settings { logbook_units_settings { affiliate_id unit } }", variables: {} };
  return {
    query: "query logbook_units_settings($affiliate_id: Int!) { logbook_units_settings(where: { affiliate_id: { _eq: $affiliate_id } }) { affiliate_id unit } }",
    variables: { affiliate_id: affiliateVar(affiliateId) },
  };
}

/** Write the PADI logbook display setting (an upsert; same text in both modes). */
export function setUnitsDocument(affiliateId: string, unit: string): GraphqlDocument {
  return {
    query:
      "mutation insert_logbook_units_settings($affiliate_id: Int!, $unit: units!) { insert_logbook_units_settings(objects: { affiliate_id: $affiliate_id, unit: $unit }, on_conflict: { constraint: units_settings_pkey, update_columns: unit }) { returning { affiliate_id unit } } }",
    variables: { affiliate_id: affiliateVar(affiliateId), unit },
  };
}
