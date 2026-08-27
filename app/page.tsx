"use client";

import { useMemo, useState } from "react";
import { SiteInput } from "@/components/SiteInput";
import { ScreeningResult } from "@/components/ScreeningResult";
import { Chat } from "@/components/Chat";
import type { LogResult } from "@/lib/github-log";
import type { ParticleCharacter, Scenario, ScreeningReport } from "@/types";

export default function Page() {
  const [report, setReport] = useState<ScreeningReport | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [log, setLog] = useState<LogResult | undefined>();
  const [aiAvailable, setAiAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionId = useMemo(
    () => `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`,
    [],
  );

  const [lastQuery, setLastQuery] = useState<{ site: string; notes: string }>({ site: "", notes: "" });

  async function screen(site: string, notes: string, particleCharacter?: ParticleCharacter) {
    setLastQuery({ site, notes });
    setBusy(true);
    setError(null);
    setReport(null);
    setScenario(null);

    try {
      const res = await fetch("/api/screen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ site, notes, sessionId, particleCharacter }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "The screening failed.");
        return;
      }

      setReport(data.report);
      setScenario(data.report.scenario);
      setLog(data.log);
      setAiAvailable(Boolean(data.aiAvailable));
    } catch (err) {
      setError(
        "Could not reach the server: " + (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Hydrocyclone + membrane site screening</h1>
      <p className="subtitle">
        Give it a site. It tells you which hydrocyclone and membrane combinations are worth
        investigating, and why.
      </p>

      <SiteInput onScreen={screen} busy={busy} />

      <p className="hint" style={{ marginTop: "-0.5rem", marginBottom: "1.25rem" }}>
        Getting the same result for every site?{" "}
        <a href="/diagnose">Run the diagnostic</a> — it shows which lookup failed and why.
      </p>

      {error ? <div className="banner banner--error">{error}</div> : null}

      {busy ? (
        <div className="card" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> Researching the site, loading the
          equipment catalogues and running the configuration matrix…
        </div>
      ) : null}

      {report ? (
        <ScreeningResult
          report={report}
          log={log}
          busy={busy}
          onSetCharacter={(c) => void screen(lastQuery.site, lastQuery.notes, c)}
        />
      ) : null}

      {report && scenario ? (
        <Chat
          scenario={scenario}
          aiAvailable={aiAvailable}
          sessionId={sessionId}
          onScenarioUpdate={(s, r) => {
            setScenario(s);
            setReport(r);
          }}
        />
      ) : null}

      <footer className="disclaimer">
        <p>
          <strong>Engineering disclaimer.</strong> This application provides preliminary
          engineering screening only. It does not constitute final process design, equipment
          selection, safety advice or a guarantee of membrane performance. Actual hydrocyclone and
          membrane performance should be validated using appropriate site measurements and
          pilot/bench testing.
        </p>
        <p>
          <strong>Privacy.</strong> Do not enter confidential, personal or commercially sensitive
          information into this prototype. Screening requests and AI conversations are logged to a
          GitHub repository, and AI queries are sent to the configured AI provider.
        </p>
      </footer>
    </main>
  );
}
