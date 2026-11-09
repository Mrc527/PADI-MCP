import { describe, expect, it } from "vitest";
import {
  allowedSkills,
  canonicalEquipment,
  describeEnum,
  ENUMS,
  enumLabel,
  isEnumValue,
  isLockedStatus,
  parseAdventureDive,
  parseEnum,
  trainingDive,
} from "../../src/logbook/enums.js";

describe("parseEnum", () => {
  it("accepts the exact PADI values", () => {
    for (const [kind, def] of Object.entries(ENUMS)) {
      for (const value of def.values) expect(parseEnum(kind as keyof typeof ENUMS, value)).toBe(value);
    }
  });

  it("accepts lenient aliases, ignoring case, spaces and separators", () => {
    expect(parseEnum("dive_type", "shore")).toBe("BeachShore");
    expect(parseEnum("dive_type", "Beach")).toBe("BeachShore");
    expect(parseEnum("dive_type", "BOAT")).toBe("Boat");
    expect(parseEnum("suit", "3mm")).toBe("FullSuit_3mm");
    expect(parseEnum("suit", "5 mm wetsuit")).toBe("FullSuit_5mm");
    expect(parseEnum("suit", "fullsuit_7mm")).toBe("FullSuit_7mm");
    expect(parseEnum("suit", "semi-dry")).toBe("SemiDrySuit");
    expect(parseEnum("suit", "dry suit")).toBe("DrySuit");
    expect(parseEnum("gas", "EAN32")).toBe("Enriched_32");
    expect(parseEnum("gas", "nitrox 32")).toBe("Enriched_32");
    expect(parseEnum("gas", "EANx36")).toBe("Enriched_36");
    expect(parseEnum("gas", "ean 40%")).toBe("Enriched_40");
    expect(parseEnum("gas", "nitrox")).toBe("Enriched");
    expect(parseEnum("current", "light current")).toBe("SomeCurrent");
    expect(parseEnum("current", "light")).toBe("SomeCurrent");
    expect(parseEnum("current", "none")).toBe("NoCurrent");
    expect(parseEnum("surge", "strong surge")).toBe("BigSurge");
    expect(parseEnum("surge", "light")).toBe("SomeSurge");
    expect(parseEnum("weather", "partly cloudy")).toBe("Partly Cloudy");
    expect(parseEnum("weather", "PartlyCloudy")).toBe("Partly Cloudy");
    expect(parseEnum("waves", "calm")).toBe("NoWaves");
    expect(parseEnum("cylinder_type", "aluminium")).toBe("Aluminum");
    expect(parseEnum("course", "AOW")).toBe("Advanced");
    expect(parseEnum("course", "open water")).toBe("Open");
    expect(parseEnum("status", "qr code verified")).toBe("QR Code Verified");
    expect(parseEnum("log_type", "training")).toBe("Training");
  });

  it("maps 'no surge' to null and refuses unknown values", () => {
    expect(parseEnum("surge", "none")).toBeNull();
    expect(parseEnum("surge", "no surge")).toBeNull();
    expect(parseEnum("dive_type", "car")).toBeUndefined();
    expect(parseEnum("dive_type", "")).toBeUndefined();
    expect(parseEnum("gas", "Heliox")).toBeUndefined();
  });

  it("labels and describes values", () => {
    expect(enumLabel("dive_type", "BeachShore")).toBe("Shore");
    expect(enumLabel("current", "SomeCurrent")).toBe("Light current");
    expect(enumLabel("current", "Weird")).toBe("Weird");
    expect(describeEnum("dive_type")).toBe("Boat, BeachShore (Shore), Other");
    expect(describeEnum("water_type")).toContain("Salt");
    expect(isEnumValue("gas", "Air")).toBe(true);
    expect(isEnumValue("gas", "air")).toBe(false);
  });
});

describe("other catalogues", () => {
  it("knows the locked statuses", () => {
    expect(isLockedStatus("Pending")).toBe(true);
    expect(isLockedStatus("Verified")).toBe(true);
    expect(isLockedStatus("QR Code Verified")).toBe(true);
    expect(isLockedStatus("Resubmit")).toBe(false);
    expect(isLockedStatus("Draft")).toBe(false);
    expect(isLockedStatus(null)).toBe(false);
  });

  it("knows the training dives", () => {
    expect(trainingDive("Open", 2)?.title).toBe("Open Water Training Dive 2");
    expect(trainingDive("Advanced", 5)?.title).toBe("Adventure Dive - Deep");
    expect(trainingDive("Advanced", 2)).toBeUndefined();
    expect(trainingDive("Reactivate", 13)?.title).toBe("ReActivate");
  });

  it("matches adventure dives leniently", () => {
    expect(parseAdventureDive("night")).toBe("Night Diving");
    expect(parseAdventureDive("wreck diving")).toBe("Wreck Diving");
    expect(parseAdventureDive("Rescue")).toBe("Rescue");
    expect(parseAdventureDive("dpv")).toBeUndefined();
    expect(parseAdventureDive("Diver Propulsion Vehicle (DPV)")).toBe("Diver Propulsion Vehicle (DPV)");
  });

  it("lists the allowed skills per course and dive", () => {
    expect(allowedSkills("Open", 1)).not.toContain("controlled ascent");
    expect(allowedSkills("Open", 2)).toContain("controlled ascent");
    expect(allowedSkills("Rescue", 10)).toContain("tired diver");
    expect(allowedSkills("Advanced", 5)).toEqual([]);
  });

  it("spells equipment the PADI way", () => {
    expect(canonicalEquipment("hoods")).toBe("Hood");
    expect(canonicalEquipment(" gloves ")).toBe("Gloves");
    expect(canonicalEquipment("Dive light")).toBe("Dive light");
  });
});
