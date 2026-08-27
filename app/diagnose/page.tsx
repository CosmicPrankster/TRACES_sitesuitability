"use client";

import { useState } from "react";

interface ProviderRow {
  id: string;
  name: string;
  status: string;
  message: string;
  url?: string;
  durationMs?: number;
  canInfluenceAnswer: boolean;
}

interface Diagnosis {
  site: string;
  verdict: string;
  fix: string[];
  rootCause: string;
  environment: {
    remoteLookupsEnabled: boolean;
    userAgent: string;
    userAgentIsDefault: boolean;
    aiConfigured: boolean;
    loggingConfigured: boolean;
    bgsEndpoint: string;
  };
  resolved: { name: string | null; latitude: number | null; longitude: number | null };
  outcome: {
    siteSpecific: boolean;
    particleCharacter: string;
    particleCharacterProvenance: string;
    particleCharacterBasis: string;
    psdD50Um: number | null;
    matrixSignature: string;
    overall: string;
    confidence: string;
  };
  providers: ProviderRow[];
  totalMs: number;
}

const TONE: Record<string, string> = {
  ok: "positive",
  no_data: "caution",
  skipped: "caution",
  error: "negative",
};

/**
 * A plain-language answer to "why is it giving me the same thing every time?".
 * Deliberately a page rather than a CLI script: it needs no terminal, no
 * environment-variable syntax, and works the same on every platform.
 */
export default function DiagnosePage() {
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Diagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!site.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ site: site.trim() }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "The diagnosis failed.");
      else setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Why am I getting this result?</h1>
      <p className="subtitle">
        Runs the real lookup for a site and shows you exactly which step failed, what it said, and
        what to do about it.
      </p>

      <form className="card" onSubmit={run}>
        <label htmlFor="d-site">Site to diagnose</label>
        <input
          id="d-site"
          type="text"
          value={site}
          placeholder="River Thames, Battersea"
          onChange={(e) => setSite(e.target.value)}
          disabled={busy}
        />
        <div className="row" style={{ marginTop: "0.9rem" }}>
          <button type="submit" disabled={busy || !site.trim()}>
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" /> Running every lookup…
              </>
            ) : (
              "Diagnose"
            )}
          </button>
          <a href="/" style={{ fontSize: "0.9rem" }}>
            ← back to screening
          </a>
        </div>
      </form>

      {error ? <div className="banner banner--error">{error}</div> : null}

      {result ? (
        <>
          <section className="card">
            <div className="section-label">What is going on</div>
            <p style={{ fontSize: "1.05rem", fontWeight: 600 }}>{result.verdict}</p>

            <div className="section-label" style={{ marginTop: "1.2rem" }}>
              How to fix it
            </div>
            <ol className="tight">
              {result.fix.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h2>Every lookup, in order</h2>
            <p className="hint">
              The last column is the one that matters. A provider that cannot influence the answer
              can succeed all day and the matrix will not move.
            </p>
            <div className="matrix-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Lookup</th>
                    <th>Result</th>
                    <th>What it said</th>
                    <th>Can move the matrix?</th>
                  </tr>
                </thead>
                <tbody>
                  {result.providers.map((p) => (
                    <tr key={p.id}>
                      <th scope="row">
                        {p.name}
                        {p.durationMs !== undefined ? (
                          <div className="hint">{p.durationMs} ms</div>
                        ) : null}
                      </th>
                      <td>
                        <span className={`pill pill--${TONE[p.status] ?? "neutral"}`}>{p.status}</span>
                      </td>
                      <td>
                        {p.message}
                        {p.url ? (
                          <div className="hint" style={{ marginTop: "0.3rem", wordBreak: "break-all" }}>
                            <a href={p.url} target="_blank" rel="noreferrer noopener">
                              {p.url}
                            </a>
                            <div>Open this in a browser. If it works there but failed here, it is a network or User-Agent problem, not a code problem.</div>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`pill pill--${p.canInfluenceAnswer ? "positive" : "neutral"}`}>
                          {p.canInfluenceAnswer ? "yes" : "no"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h2>What came out</h2>
            <table className="data">
              <tbody>
                <tr>
                  <th scope="row">Resolved to</th>
                  <td>
                    {result.resolved.name ?? "— nothing —"}
                    {result.resolved.latitude !== null
                      ? ` (${result.resolved.latitude}, ${result.resolved.longitude})`
                      : ""}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Site-specific?</th>
                  <td>
                    <span className={`pill pill--${result.outcome.siteSpecific ? "positive" : "negative"}`}>
                      {result.outcome.siteSpecific ? "yes" : "no — this is the default"}
                    </span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Solids taken to be</th>
                  <td>
                    {result.outcome.particleCharacter}{" "}
                    <span className={`prov prov--${result.outcome.particleCharacterProvenance}`}>
                      {result.outcome.particleCharacterProvenance}
                    </span>
                    <div className="hint">{result.outcome.particleCharacterBasis}</div>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Distribution D50</th>
                  <td>{result.outcome.psdD50Um ?? "—"} µm</td>
                </tr>
                <tr>
                  <th scope="row">Matrix fingerprint</th>
                  <td>
                    <code>{result.outcome.matrixSignature}</code>
                    <div className="hint">
                      Diagnose two different sites. If this string is identical, nothing
                      site-specific is reaching the engine.
                    </div>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Verdict</th>
                  <td>
                    {result.outcome.overall} · confidence {result.outcome.confidence}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <h2>This server&rsquo;s settings</h2>
            <table className="data">
              <tbody>
                <tr>
                  <th scope="row">Remote lookups</th>
                  <td>{result.environment.remoteLookupsEnabled ? "enabled" : "DISABLED"}</td>
                </tr>
                <tr>
                  <th scope="row">User-Agent</th>
                  <td>
                    {result.environment.userAgent}
                    {result.environment.userAgentIsDefault ? (
                      <div className="hint">
                        Not set. Nominatim rejects generic User-Agents with HTTP 403 — set
                        <code> SITE_DATA_USER_AGENT</code> in <code>.env.local</code> to something
                        identifiable with a contact address.
                      </div>
                    ) : null}
                  </td>
                </tr>
                <tr>
                  <th scope="row">BGS endpoint</th>
                  <td>{result.environment.bgsEndpoint}</td>
                </tr>
                <tr>
                  <th scope="row">AI chat</th>
                  <td>{result.environment.aiConfigured ? "configured" : "not configured"}</td>
                </tr>
                <tr>
                  <th scope="row">GitHub logging</th>
                  <td>{result.environment.loggingConfigured ? "configured" : "not configured"}</td>
                </tr>
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
              Whole diagnosis took {result.totalMs} ms.
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}
