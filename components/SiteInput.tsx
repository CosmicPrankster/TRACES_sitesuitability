"use client";

import { useState } from "react";

/**
 * The whole of the required user input: one site. Everything else is optional.
 */
export function SiteInput({
  onScreen,
  busy,
}: {
  onScreen: (site: string, notes: string) => void;
  busy: boolean;
}) {
  const [site, setSite] = useState("");
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        if (site.trim() && !busy) onScreen(site.trim(), notes.trim());
      }}
    >
      <label htmlFor="site">Enter a site</label>
      <p className="hint">
        A place name is enough. Everything else — the site research, the equipment data and the
        engineering — is done for you.
      </p>
      <input
        id="site"
        type="text"
        value={site}
        placeholder="Tilford, River Wey"
        autoComplete="off"
        onChange={(e) => setSite(e.target.value)}
        disabled={busy}
      />

      {showNotes ? (
        <div style={{ marginTop: "0.9rem" }}>
          <label htmlFor="notes">Anything you already know (optional)</label>
          <textarea
            id="notes"
            value={notes}
            placeholder="Water appears to contain mostly sand. I have a PSD: D10 2 µm, D50 25 µm, D90 150 µm."
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy}
          />
        </div>
      ) : null}

      <div className="row" style={{ marginTop: "0.9rem" }}>
        <button type="submit" disabled={busy || !site.trim()}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" /> Screening…
            </>
          ) : (
            "Screen site"
          )}
        </button>
        {!showNotes ? (
          <button type="button" className="secondary" onClick={() => setShowNotes(true)} disabled={busy}>
            Add what you already know
          </button>
        ) : null}
      </div>

      <p className="hint" style={{ marginTop: "0.9rem", marginBottom: 0 }}>
        Do not enter confidential, personal or commercially sensitive information into this
        prototype. Assessments are logged to a public GitHub repository.
      </p>
    </form>
  );
}
