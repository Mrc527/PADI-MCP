import { describe, expect, it } from "vitest";
import { formatMinutes, fromMetric, round, toMetric, unitLabels } from "../../src/logbook/units.js";

describe("units", () => {
  it("converts imperial input to the metric values PADI stores (3 decimals)", () => {
    expect(toMetric("depth", 100, "imperial")).toBe(30.48);
    expect(toMetric("temp", 77, "imperial")).toBe(25);
    expect(toMetric("temp", 70, "imperial")).toBe(21.111);
    expect(toMetric("pressure", 3000, "imperial")).toBe(206.843);
    expect(toMetric("weight", 10, "imperial")).toBe(4.536);
    expect(toMetric("volume", 80, "imperial")).toBe(2265.348);
    expect(toMetric("depth", 18.12345, "metric")).toBe(18.123);
  });

  it("shows metric values with up to 2 decimals and imperial values rounded for a log", () => {
    expect(fromMetric("depth", 30.48, "metric")).toBe(30.48);
    expect(fromMetric("depth", 10.000000001, "metric")).toBe(10);
    expect(fromMetric("depth", 30.48, "imperial")).toBe(100);
    expect(fromMetric("temp", 21.111, "imperial")).toBe(70);
    expect(fromMetric("temp", 0, "imperial")).toBe(32);
    expect(fromMetric("pressure", 200, "imperial")).toBe(2901);
    expect(fromMetric("weight", 4.536, "imperial")).toBe(10);
    expect(fromMetric("volume", 11.1, "imperial")).toBe(0.39);
  });

  it("round-trips imperial values", () => {
    for (const [q, v] of [
      ["depth", 66],
      ["temp", 82],
      ["pressure", 2900],
      ["weight", 14],
    ] as const) {
      expect(fromMetric(q, toMetric(q, v, "imperial"), "imperial")).toBe(v);
    }
  });

  it("labels units and formats minutes", () => {
    expect(unitLabels("metric")).toEqual({ depth: "m", temp: "C", pressure: "bar", weight: "kg", volume: "l" });
    expect(unitLabels("imperial")).toEqual({ depth: "ft", temp: "F", pressure: "psi", weight: "lb", volume: "cuft" });
    expect(formatMinutes(135)).toBe("2:15");
    expect(formatMinutes(5)).toBe("0:05");
    expect(round(-0.0001, 2)).toBe(0);
    expect(Object.is(round(-0.0001, 2), -0)).toBe(false);
  });
});
