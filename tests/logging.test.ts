import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, CSV_HEADER, csvEscape, reportToLogRow, rowToCsv } from "@/lib/github-log";
import { runScreening } from "@/lib/screening";
import { getSiteData } from "@/lib/site";

describe("CSV encoding", () => {
  it("escapes commas, quotes and newlines so a row can never break the file", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line one\nline two")).toBe("line one line two");
  });

  it("writes exactly one field per column", async () => {
    const siteData = await getSiteData("Tilford, River Wey", { enableRemote: false });
    const report = runScreening({
      scenario: { siteQuery: "Tilford, River Wey", siteData, changeLog: [] },
    });
    const line = rowToCsv(reportToLogRow(report, { sessionId: "test" }));

    // Count fields the way a CSV parser would.
    let fields = 1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "," && !inQuotes) fields += 1;
    }
    expect(fields).toBe(CSV_COLUMNS.length);
    expect(line).not.toContain("\n");
  });

  it("keeps the committed header in step with the schema", () => {
    expect(CSV_HEADER.split(",")).toEqual([...CSV_COLUMNS]);
  });

  it("captures the assessment, its confidence and its assumptions", async () => {
    const siteData = await getSiteData("Tilford, River Wey", { enableRemote: false });
    const report = runScreening({
      scenario: { siteQuery: "Tilford, River Wey", siteData, changeLog: [] },
    });
    const row = reportToLogRow(report, { sessionId: "s1", userQuestion: "why?", aiResponse: "because" });

    expect(row.site_input).toContain("Tilford");
    expect(row.confidence).toBe("low");
    expect(row.configuration_results).toContain("10mmx10um=");
    expect(row.hydrocyclone_configurations).toContain("4mm");
    expect(row.assumptions.length).toBeGreaterThan(0);
    expect(row.user_question).toBe("why?");
  });
});
