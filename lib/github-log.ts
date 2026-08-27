import type { ScreeningReport } from "@/types";

/**
 * Append-only CSV logging to a GitHub repository, via the Contents API.
 *
 * This is deliberately the prototype's entire persistence layer: no database.
 *
 * SECURITY: this module is server-only. The token is read from the environment
 * inside the Next.js server runtime and is never sent to, or referenced by, the
 * browser. The browser calls our own API route; the API route calls GitHub.
 *
 * FAILURE POLICY: logging must never break an assessment. Every failure path
 * returns a `LogResult` with `ok: false` and a message for a non-critical
 * warning in the UI. Nothing here throws.
 */

export const CSV_COLUMNS = [
  "timestamp",
  "query_id",
  "session_id",
  "site_input",
  "site_data_summary",
  "hydrocyclone_configurations",
  "membrane_configurations",
  "configuration_results",
  "overall_assessment",
  "confidence",
  "assumptions",
  "sources",
  "user_question",
  "ai_response",
] as const;

export const CSV_HEADER = CSV_COLUMNS.join(",");

export interface LogResult {
  ok: boolean;
  message: string;
  /** True when logging was not attempted because it is not configured. */
  skipped?: boolean;
  url?: string;
}

export interface LogRow {
  timestamp: string;
  query_id: string;
  session_id: string;
  site_input: string;
  site_data_summary: string;
  hydrocyclone_configurations: string;
  membrane_configurations: string;
  configuration_results: string;
  overall_assessment: string;
  confidence: string;
  assumptions: string;
  sources: string;
  user_question: string;
  ai_response: string;
}

/** RFC 4180 field escaping. */
export function csvEscape(value: string): string {
  const v = (value ?? "").replace(/\r?\n/g, " ").trim();
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function rowToCsv(row: LogRow): string {
  return CSV_COLUMNS.map((c) => csvEscape(String(row[c] ?? ""))).join(",");
}

/** Flattens a report into the flat CSV shape. */
export function reportToLogRow(
  report: ScreeningReport,
  opts: { sessionId: string; userQuestion?: string; aiResponse?: string },
): LogRow {
  const siteSummary = [
    report.siteData.resolvedName ?? report.siteData.query,
    report.siteData.waterBody ? `water body: ${report.siteData.waterBody}` : undefined,
    report.siteData.catchment ? `catchment: ${report.siteData.catchment}` : undefined,
    `solids character: ${report.siteData.particleCharacter}`,
    report.psdStatistics
      ? `D10/D50/D90 = ${report.psdStatistics.d10Um}/${report.psdStatistics.d50Um}/${report.psdStatistics.d90Um} µm (${report.psdStatistics.provenance})`
      : undefined,
    `providers: ${report.siteData.providerReports.map((p) => `${p.providerId}=${p.status}`).join(" ")}`,
  ]
    .filter(Boolean)
    .join("; ");

  const results = report.matrix
    .map((c) => `${c.hydrocycloneId}x${c.membraneId}=${c.classification}/${c.confidence}`)
    .join(" ");

  return {
    timestamp: report.timestamp,
    query_id: report.queryId,
    session_id: opts.sessionId,
    site_input: report.siteQuery + (report.userNotes ? ` | notes: ${report.userNotes}` : ""),
    site_data_summary: siteSummary,
    hydrocyclone_configurations: report.hydrocyclones.map((h) => h.id).join(" "),
    membrane_configurations: report.membranes.map((m) => m.id).join(" "),
    configuration_results: results,
    overall_assessment: `${report.overall.classification}: ${report.overall.userLabel}`,
    confidence: report.overall.confidence,
    assumptions: report.narrative.assumed.join(" | ").slice(0, 2000),
    sources: report.sources
      .map((s) => `${s.parameter}=${s.value}${s.unit ? ` ${s.unit}` : ""} [${s.provenance}${s.source ? `: ${s.source}` : ""}]`)
      .join(" | ")
      .slice(0, 2000),
    user_question: opts.userQuestion ?? "",
    ai_response: (opts.aiResponse ?? "").slice(0, 4000),
  };
}

/* -------------------------------------------------------------------------- */

interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

function readConfig(): GitHubConfig | undefined {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) return undefined;
  return {
    token,
    owner,
    repo,
    branch: process.env.GITHUB_BRANCH || "main",
    path: process.env.GITHUB_LOG_PATH || "data/query_log.csv",
  };
}

export function isLoggingConfigured(): boolean {
  return readConfig() !== undefined;
}

const API = "https://api.github.com";

async function gh(cfg: GitHubConfig, url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
}

/**
 * Appends one CSV line. Reads the current file to get its SHA, appends, and
 * writes back. A concurrent write invalidates the SHA, so the whole cycle is
 * retried a few times before giving up.
 */
export async function appendLogRow(row: LogRow, attempts = 3): Promise<LogResult> {
  const cfg = readConfig();
  if (!cfg) {
    return {
      ok: false,
      skipped: true,
      message:
        "Logging is not configured (GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO are not all set), " +
        "so this assessment was not recorded.",
    };
  }

  const contentsUrl = `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}`;
  const line = rowToCsv(row);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const getRes = await gh(cfg, `${contentsUrl}?ref=${encodeURIComponent(cfg.branch)}`);

      let existing = "";
      let sha: string | undefined;

      if (getRes.status === 200) {
        const body = (await getRes.json()) as { content?: string; sha?: string; encoding?: string };
        sha = body.sha;
        if (body.content) {
          existing = Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
        }
      } else if (getRes.status !== 404) {
        const text = await getRes.text();
        return {
          ok: false,
          message: `Could not read ${cfg.path} from GitHub (HTTP ${getRes.status}). ${text.slice(0, 200)}`,
        };
      }

      const hasHeader = existing.trimStart().startsWith(CSV_COLUMNS[0]);
      const base = existing.length === 0 ? `${CSV_HEADER}\n` : hasHeader ? existing : `${CSV_HEADER}\n${existing}`;
      const next = (base.endsWith("\n") ? base : `${base}\n`) + line + "\n";

      const putRes = await gh(cfg, contentsUrl, {
        method: "PUT",
        body: JSON.stringify({
          message: `log: screening ${row.query_id} (${row.site_input.slice(0, 60)})`,
          content: Buffer.from(next, "utf8").toString("base64"),
          branch: cfg.branch,
          ...(sha ? { sha } : {}),
        }),
      });

      if (putRes.ok) {
        return {
          ok: true,
          message: `Logged to ${cfg.owner}/${cfg.repo}/${cfg.path}.`,
          url: `https://github.com/${cfg.owner}/${cfg.repo}/blob/${cfg.branch}/${cfg.path}`,
        };
      }

      // 409 means someone else wrote first; re-read and retry.
      if (putRes.status === 409 && attempt < attempts) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }

      const text = await putRes.text();
      return {
        ok: false,
        message: `Could not write ${cfg.path} to GitHub (HTTP ${putRes.status}). ${text.slice(0, 200)}`,
      };
    } catch (err) {
      if (attempt >= attempts) {
        return {
          ok: false,
          message: `Logging failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  return { ok: false, message: "Logging failed after all retries." };
}
