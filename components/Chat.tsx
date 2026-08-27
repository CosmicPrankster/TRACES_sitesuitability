"use client";

import { useRef, useState } from "react";
import type { ChatMessage } from "@/lib/ai";
import type { Scenario, ScreeningReport } from "@/types";

const SUGGESTIONS = [
  "Why is 10 µm better than 5 µm here?",
  "Compare the 4 mm and 10 mm cyclones.",
  "What if the particles are mostly clay?",
  "I have a PSD: D10 2 µm, D50 25 µm, D90 150 µm.",
  "Which configuration would you test first?",
];

/**
 * Optional conversational layer. The scenario lives here on the client and is
 * sent back with each turn, so the server stays stateless.
 */
export function Chat({
  scenario,
  aiAvailable,
  sessionId,
  onScenarioUpdate,
}: {
  scenario: Scenario;
  aiAvailable: boolean;
  sessionId: string;
  onScenarioUpdate: (scenario: Scenario, report: ScreeningReport) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    const next = [...messages, { role: "user" as const, content: question }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, history: messages, scenario, sessionId }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "The request failed.");
        setBusy(false);
        return;
      }

      setMessages([...next, { role: "assistant", content: data.reply }]);
      if (data.scenario && data.report) onScenarioUpdate(data.scenario, data.report);
      requestAnimationFrame(() => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="chat-heading">
      <h2 id="chat-heading">Ask about this assessment</h2>

      {!aiAvailable ? (
        <div className="banner banner--info">
          The conversational layer is not configured on this server. The screening report above is
          complete without it — it is produced entirely by the deterministic engine. To enable
          chat, set <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> (see{" "}
          <code>.env.example</code>) and restart.
        </div>
      ) : (
        <p className="hint">
          Tell it what you know and it will update the scenario and re-run the matrix — it does not
          change the answer by reasoning alone.
        </p>
      )}

      {scenario.changeLog.length > 0 ? (
        <div className="banner banner--info">
          <strong>Scenario changes so far: </strong>
          {scenario.changeLog.join(" ")}
        </div>
      ) : null}

      {messages.length > 0 ? (
        <div className="chat-log" ref={logRef}>
          {messages.map((m, i) => (
            <div key={i} className={`msg msg--${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy ? (
            <div className="msg msg--assistant" aria-live="polite">
              <span className="spinner" aria-hidden="true" /> Thinking…
            </div>
          ) : null}
        </div>
      ) : null}

      {messages.length === 0 ? (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} disabled={busy || !aiAvailable}>
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="banner banner--error">{error}</div> : null}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Your question
        </label>
        <input
          id="chat-input"
          type="text"
          value={input}
          placeholder="Why? What about the 4 mm? Here’s my PSD…"
          onChange={(e) => setInput(e.target.value)}
          disabled={busy || !aiAvailable}
          style={{ flex: "1 1 260px" }}
        />
        <button type="submit" disabled={busy || !aiAvailable || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
