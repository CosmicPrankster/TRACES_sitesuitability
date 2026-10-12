import { describe, expect, it } from "vitest";
import { parseFreeTextObservation } from "@/lib/chat-intake";
import { psdFromFieldObservation } from "@/lib/field-update";

describe("parseFreeTextObservation: grain-card class", () => {
  it("recognises a qualified sand class over the bare word", () => {
    const r = parseFreeTextObservation("Looks like fine sand to me.");
    expect(r.input.grainCardClass).toBe("fine_sand");
    expect(r.parsedFrom.join(" ")).toMatch(/fine sand/);
  });

  it("recognises coarse sand, medium sand, silt, clay and gravel", () => {
    expect(parseFreeTextObservation("coarse sand here").input.grainCardClass).toBe("coarse_sand");
    expect(parseFreeTextObservation("medium sand here").input.grainCardClass).toBe("medium_sand");
    expect(parseFreeTextObservation("mostly silty water").input.grainCardClass).toBe("silt");
    expect(parseFreeTextObservation("clayey and thick").input.grainCardClass).toBe("clay");
    expect(parseFreeTextObservation("just gravel, bed material").input.grainCardClass).toBe("gravel");
  });

  it("reads a bare, unqualified 'sand' as medium sand and says so", () => {
    const r = parseFreeTextObservation("sandy bed, nothing finer");
    expect(r.input.grainCardClass).toBe("medium_sand");
    expect(r.parsedFrom.join(" ")).toMatch(/no size given/);
  });

  it("takes the LAST mention as a correction of an earlier one", () => {
    const r = parseFreeTextObservation("thought it was silt at first, actually it's clay");
    expect(r.input.grainCardClass).toBe("clay");
  });

  it("warns, rather than guesses, when no class is mentioned at all", () => {
    const r = parseFreeTextObservation("the water looked a bit murky today");
    expect(r.input.grainCardClass).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/no grain-card size class recognised/i);
  });
});

describe("parseFreeTextObservation: settle test", () => {
  it("parses a rapid clear in minutes", () => {
    const r = parseFreeTextObservation("fine sand, cleared within 10 minutes");
    expect(r.input.settleTest).toEqual({ clearedWithinMinutes: 10, observedForHours: null });
  });

  it("parses several real phrasings of a rapid clear", () => {
    for (const msg of [
      "it cleared in 8 mins",
      "settled within about 12 minutes",
      "cleared after 5 min",
    ]) {
      const r = parseFreeTextObservation(`sand, ${msg}`);
      expect(r.input.settleTest, msg).not.toBeUndefined();
      expect(r.input.settleTest!.observedForHours).toBeNull();
    }
  });

  it("parses a persistent haze in hours", () => {
    const r = parseFreeTextObservation("silt, still hazy after 3 hours");
    expect(r.input.settleTest).toEqual({ clearedWithinMinutes: null, observedForHours: 3 });
  });

  it("parses 'didn't clear after N hours' phrasing", () => {
    const r = parseFreeTextObservation("clay, didn't clear after 2 hours, gave up watching");
    expect(r.input.settleTest).toEqual({ clearedWithinMinutes: null, observedForHours: 2 });
  });

  it("reports a genuinely contradictory message rather than picking one side", () => {
    const r = parseFreeTextObservation("sand, cleared in 5 minutes but also still hazy after 2 hours");
    expect(r.input.settleTest).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/too contradictory/i);
  });

  it("leaves settleTest unset when the message says nothing about settling", () => {
    const r = parseFreeTextObservation("fine sand, that's all I saw");
    expect(r.input.settleTest).toBeUndefined();
  });
});

describe("parseFreeTextObservation: turbidity tube", () => {
  it("parses an explicit turbidity tube reading", () => {
    const r = parseFreeTextObservation("sand. turbidity tube read 14 cm before the pattern vanished");
    expect(r.input.turbidityTubeReadingCm).toBe(14);
  });

  it("parses a bare cm figure when 'turbidity' is mentioned elsewhere in the message", () => {
    const r = parseFreeTextObservation("silt, turbidity was bad, could only see 6 cm down");
    expect(r.input.turbidityTubeReadingCm).toBe(6);
  });

  it("does not mistake an unrelated cm figure for a turbidity reading", () => {
    const r = parseFreeTextObservation("sand, water depth about 30 cm at the bank");
    expect(r.input.turbidityTubeReadingCm).toBeUndefined();
  });
});

describe("parseFreeTextObservation: keeps the original message as siteNote, always", () => {
  it("never drops the raw text, even when fully parsed", () => {
    const msg = "fine sand, cleared within 10 minutes, turbidity tube 14 cm";
    const r = parseFreeTextObservation(msg);
    expect(r.input.siteNote).toBe(msg);
  });
});

describe("parseFreeTextObservation feeds straight into psdFromFieldObservation unchanged", () => {
  it("a realistic field message produces the same result the structured form would for equivalent fields", () => {
    const chat = parseFreeTextObservation("Looks like fine sand, cleared within 10 minutes.");
    const direct = psdFromFieldObservation({
      grainCardClass: "fine_sand",
      settleTest: { clearedWithinMinutes: 10, observedForHours: null },
    });
    const viaChat = psdFromFieldObservation(chat.input);
    expect(viaChat!.psd).toEqual(direct!.psd);
  });

  it("a message with no grain-card class parses to null downstream, same as the form would", () => {
    const chat = parseFreeTextObservation("the river looked a bit cloudy");
    expect(psdFromFieldObservation(chat.input)).toBeNull();
  });
});
