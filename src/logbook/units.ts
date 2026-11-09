/**
 * Metric and imperial units. PADI always stores metric values (m, degrees C, bar, kg, litres);
 * its "units" setting only changes how the web app shows them. This server converts on the way
 * in and out.
 *
 * Rounding: values written to PADI keep 3 decimals (as the PADI web app does). Metric values are
 * shown with up to 2 decimals (what was stored, without float noise). Imperial values are shown
 * with what makes sense for a dive log: depth and temperature 0.1, pressure 1, weight 0.1,
 * volume 0.01 cubic foot.
 */

import type { DiveUnits, UnitSystem } from "./types.js";

export type Quantity = "depth" | "temp" | "pressure" | "weight" | "volume";

export const FT_PER_M = 1 / 0.3048;
export const PSI_PER_BAR = 14.503773773;
export const LB_PER_KG = 1 / 0.45359237;
export const CUFT_PER_L = 1 / 28.316846592;

export const METRIC_UNITS: Readonly<DiveUnits> = Object.freeze({ depth: "m", temp: "C", pressure: "bar", weight: "kg", volume: "l" });
export const IMPERIAL_UNITS: Readonly<DiveUnits> = Object.freeze({ depth: "ft", temp: "F", pressure: "psi", weight: "lb", volume: "cuft" });

/** The unit labels of a unit system. */
export function unitLabels(system: UnitSystem): DiveUnits {
  return { ...(system === "imperial" ? IMPERIAL_UNITS : METRIC_UNITS) };
}

/** Round to a number of decimals, without float noise (and without "-0"). */
export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

const METRIC_DECIMALS = 2;
const IMPERIAL_DECIMALS: Record<Quantity, number> = { depth: 1, temp: 1, pressure: 0, weight: 1, volume: 2 };

/** A stored (metric) value in a unit system, rounded for display. */
export function fromMetric(quantity: Quantity, value: number, system: UnitSystem): number {
  if (system === "metric") return round(value, METRIC_DECIMALS);
  let v: number;
  switch (quantity) {
    case "depth":
      v = value * FT_PER_M;
      break;
    case "temp":
      v = (value * 9) / 5 + 32;
      break;
    case "pressure":
      v = value * PSI_PER_BAR;
      break;
    case "weight":
      v = value * LB_PER_KG;
      break;
    case "volume":
      v = value * CUFT_PER_L;
      break;
  }
  return round(v, IMPERIAL_DECIMALS[quantity]);
}

/** A value in a unit system, converted to the metric value PADI stores (3 decimals). */
export function toMetric(quantity: Quantity, value: number, system: UnitSystem): number {
  if (system === "metric") return round(value, 3);
  let v: number;
  switch (quantity) {
    case "depth":
      v = value / FT_PER_M;
      break;
    case "temp":
      v = ((value - 32) * 5) / 9;
      break;
    case "pressure":
      v = value / PSI_PER_BAR;
      break;
    case "weight":
      v = value / LB_PER_KG;
      break;
    case "volume":
      v = value / CUFT_PER_L;
      break;
  }
  return round(v, 3);
}

/** "m", "ft", "C", ...: the unit of a quantity in a system. */
export function unitOf(quantity: Quantity, system: UnitSystem): string {
  return unitLabels(system)[quantity];
}

/** Minutes as "h:mm", for example 135 -> "2:15". */
export function formatMinutes(total: number): string {
  const minutes = Math.max(0, Math.round(total));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}
