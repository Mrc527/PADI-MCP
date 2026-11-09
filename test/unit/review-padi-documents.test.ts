/**
 * The exact text and variables of the logbook GraphQL documents, in both modes, as
 * docs/padi-api.md section 3.3 gives them. A filter that is declared but not applied (for example
 * `$log_type` without `log_type: { _eq: $log_type }`) filters nothing and is easy to miss with
 * partial checks: these tests compare the whole document.
 */
import { describe, expect, it } from "vitest";
import {
  countDocument,
  deleteDocument,
  FULL_FIELDS,
  getDocument,
  listDocument,
  SUMMARY_FIELDS,
  totalBottomTimeDocument,
  unitsDocument,
} from "../../src/padi/documents.js";

const AFF = "10000001";
const ORDER = "order_by: { dive_date: desc, id: desc }";
const SUMMARY = "{ id log_type log_course log_number dive_title dive_date dive_location status }";

describe("list documents", () => {
  it("proxy mode: scoped by affiliate id, with the log type or status filter applied", () => {
    expect(listDocument("proxy", AFF, { limit: 15, offset: 0, selection: "summary" })).toEqual({
      query: `query logbook_logs($affiliate_id: Int!, $limit: Int, $offset: Int) { logbook_logs(where: { affiliate_id: { _eq: $affiliate_id } }, ${ORDER}, limit: $limit, offset: $offset) ${SUMMARY} }`,
      variables: { affiliate_id: 10000001, limit: 15, offset: 0 },
    });
    expect(listDocument("proxy", AFF, { limit: 15, offset: 0, logType: "Training", selection: "summary" })).toEqual({
      query: `query logbook_logs($affiliate_id: Int!, $log_type: log_type, $limit: Int, $offset: Int) { logbook_logs(where: { affiliate_id: { _eq: $affiliate_id }, log_type: { _eq: $log_type } }, ${ORDER}, limit: $limit, offset: $offset) ${SUMMARY} }`,
      variables: { affiliate_id: 10000001, log_type: "Training", limit: 15, offset: 0 },
    });
    expect(listDocument("proxy", AFF, { limit: 15, offset: 30, status: "Pending", selection: "summary" })).toEqual({
      query: `query logbook_logs($affiliate_id: Int!, $status: status, $limit: Int, $offset: Int) { logbook_logs(where: { affiliate_id: { _eq: $affiliate_id }, status: { _eq: $status } }, ${ORDER}, limit: $limit, offset: $offset) ${SUMMARY} }`,
      variables: { affiliate_id: 10000001, status: "Pending", limit: 15, offset: 30 },
    });
  });

  it("direct mode: no affiliate id, with the log type or status filter applied", () => {
    expect(listDocument("direct", AFF, { limit: 15, offset: 0, selection: "summary" })).toEqual({
      query: `query logbook_logs($limit: Int, $offset: Int) { logbook_logs(${ORDER}, limit: $limit, offset: $offset) ${SUMMARY} }`,
      variables: { limit: 15, offset: 0 },
    });
    expect(listDocument("direct", AFF, { limit: 15, offset: 0, status: "Draft", selection: "summary" })).toEqual({
      query: `query logbook_logs($status: status, $limit: Int, $offset: Int) { logbook_logs(where: { status: { _eq: $status } }, ${ORDER}, limit: $limit, offset: $offset) ${SUMMARY} }`,
      variables: { status: "Draft", limit: 15, offset: 0 },
    });
    expect(listDocument("direct", AFF, { limit: null, offset: 0, logType: "Recreational", selection: "summary" })).toEqual({
      query: `query logbook_logs($log_type: log_type, $limit: Int, $offset: Int) { logbook_logs(where: { log_type: { _eq: $log_type } }, ${ORDER}, limit: $limit, offset: $offset) ${SUMMARY} }`,
      variables: { log_type: "Recreational", limit: null, offset: 0 },
    });
  });

  it("uses one filter only (log type wins, as in the PADI web app)", () => {
    for (const mode of ["proxy", "direct"] as const) {
      const both = listDocument(mode, AFF, { limit: 5, offset: 0, logType: "Training", status: "Draft", selection: "summary" });
      expect(both).toEqual(listDocument(mode, AFF, { limit: 5, offset: 0, logType: "Training", selection: "summary" }));
      expect(both.query).not.toContain("status: { _eq");
    }
  });

  it("adds depth and time, or every field, and orders by depth or time", () => {
    expect(listDocument("proxy", AFF, { limit: 5, offset: 0, order: "max_depth", selection: "depth" })).toEqual({
      query:
        "query logbook_logs($affiliate_id: Int!, $limit: Int, $offset: Int) { logbook_logs(where: { affiliate_id: { _eq: $affiliate_id } }, " +
        "order_by: { depth_times_aggregate: { max: { max_depth: desc } } }, limit: $limit, offset: $offset) " +
        `{ ${SUMMARY_FIELDS} dive_type depth_times { max_depth bottom_time } } }`,
      variables: { affiliate_id: 10000001, limit: 5, offset: 0 },
    });
    expect(listDocument("direct", AFF, { limit: null, offset: 0, order: "bottom_time", selection: "full" })).toEqual({
      query: `query logbook_logs($limit: Int, $offset: Int) { logbook_logs(order_by: { depth_times_aggregate: { max: { bottom_time: desc } } }, limit: $limit, offset: $offset) { ${FULL_FIELDS} } }`,
      variables: { limit: null, offset: 0 },
    });
  });
});

describe("count documents", () => {
  it("proxy mode", () => {
    expect(countDocument("proxy", AFF)).toEqual({
      query: "query logbook_logs_aggregate($affiliate_id: Int!) { logbook_logs_aggregate(where: { affiliate_id: { _eq: $affiliate_id } }) { aggregate { count } } }",
      variables: { affiliate_id: 10000001 },
    });
    expect(countDocument("proxy", AFF, { logType: "Training" })).toEqual({
      query:
        "query logbook_logs_aggregate($affiliate_id: Int!, $log_type: log_type) { logbook_logs_aggregate(where: { affiliate_id: { _eq: $affiliate_id }, log_type: { _eq: $log_type } }) { aggregate { count } } }",
      variables: { affiliate_id: 10000001, log_type: "Training" },
    });
    expect(countDocument("proxy", AFF, { status: "Verified" })).toEqual({
      query:
        "query logbook_logs_aggregate($affiliate_id: Int!, $status: status) { logbook_logs_aggregate(where: { affiliate_id: { _eq: $affiliate_id }, status: { _eq: $status } }) { aggregate { count } } }",
      variables: { affiliate_id: 10000001, status: "Verified" },
    });
  });

  it("direct mode", () => {
    expect(countDocument("direct", AFF)).toEqual({ query: "query logbook_logs_aggregate { logbook_logs_aggregate { aggregate { count } } }", variables: {} });
    expect(countDocument("direct", AFF, { logType: "Training" })).toEqual({
      query: "query logbook_logs_aggregate($log_type: log_type) { logbook_logs_aggregate(where: { log_type: { _eq: $log_type } }) { aggregate { count } } }",
      variables: { log_type: "Training" },
    });
    expect(countDocument("direct", AFF, { status: "Draft" })).toEqual({
      query: "query logbook_logs_aggregate($status: status) { logbook_logs_aggregate(where: { status: { _eq: $status } }) { aggregate { count } } }",
      variables: { status: "Draft" },
    });
  });
});

describe("other read documents", () => {
  it("total bottom time", () => {
    expect(totalBottomTimeDocument("proxy", AFF)).toEqual({
      query:
        "query logbook_depth_time_aggregate($affiliate_id: Int!) { logbook_depth_time_aggregate(where: { log: { affiliate_id: { _eq: $affiliate_id } } }) { aggregate { sum { bottom_time } } } }",
      variables: { affiliate_id: 10000001 },
    });
    expect(totalBottomTimeDocument("direct", AFF)).toEqual({
      query: "query logbook_depth_time_aggregate { logbook_depth_time_aggregate { aggregate { sum { bottom_time } } } }",
      variables: {},
    });
  });

  it("one dive with every field", () => {
    expect(FULL_FIELDS).toBe(
      "id log_type log_course log_number dive_type dive_title dive_date dive_location memsys_member_number status adventure_dive " +
        "depth_times { max_depth bottom_time time_in time_out } skills { dive_skills } " +
        "conditions { water_type body_of_water weather air_temp surface_water_temp bottom_water_temp visibility visibility_distance wave_condition current surge } " +
        "equipment { suit_type weight weight_type additional_equipment cylinder_type cylinder_size gas_mixture oxygen nitrogen helium starting_pressure ending_pressure } " +
        "experiences { feeling notes buddies dive_center }",
    );
    expect(getDocument("proxy", AFF, 42)).toEqual({
      query: `query logbook_logs($affiliate_id: Int!, $id: Int!) { logbook_logs(where: { affiliate_id: { _eq: $affiliate_id }, _and: { id: { _eq: $id } } }) { ${FULL_FIELDS} } }`,
      variables: { affiliate_id: 10000001, id: 42 },
    });
    expect(getDocument("direct", AFF, 42)).toEqual({
      query: `query logbook_logs($id: Int!) { logbook_logs(where: { _and: { id: { _eq: $id } } }) { ${FULL_FIELDS} } }`,
      variables: { id: 42 },
    });
  });

  it("the units setting", () => {
    expect(unitsDocument("proxy", AFF)).toEqual({
      query: "query logbook_units_settings($affiliate_id: Int!) { logbook_units_settings(where: { affiliate_id: { _eq: $affiliate_id } }) { affiliate_id unit } }",
      variables: { affiliate_id: 10000001 },
    });
    expect(unitsDocument("direct", AFF)).toEqual({ query: "query logbook_units_settings { logbook_units_settings { affiliate_id unit } }", variables: {} });
  });
});

describe("delete document", () => {
  it("deletes the 5 child tables first, then the dive, by the same id", () => {
    const children = ["logbook_depth_time", "logbook_skills", "logbook_conditions", "logbook_experience", "logbook_equipment"];
    expect(deleteDocument("proxy", 42)).toEqual({
      query: `mutation delete_logbook_logs($id: Int) { ${children.map((t) => `delete_${t}(where: { logs_id: { _eq: $id } }) { affected_rows returning { id } }`).join(" ")} delete_logbook_logs(where: { id: { _eq: $id } }) { affected_rows returning { id } } }`,
      variables: { id: 42 },
    });
    expect(deleteDocument("direct", 42)).toEqual({
      query: `mutation delete_logbook_logs($id: Int!) { ${children.map((t) => `delete_${t}(where: { logs_id: { _eq: $id } }) { affected_rows }`).join(" ")} delete_logbook_logs(where: { id: { _eq: $id } }) { affected_rows } }`,
      variables: { id: 42 },
    });
  });
});
