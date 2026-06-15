import { tryNormalizeRepoSlug } from "@dev-loops/core/github/repo-slug";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "<p>none</p>";
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function renderDefinitionList(entries) {
  return `<dl>${entries.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

export function renderCompactSection({ title, entries = [], lists = [] }) {
  if (entries.length === 0 && lists.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><p>not present / unavailable</p></section>`;
  }

  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${entries.length > 0 ? renderDefinitionList(entries) : "<p>not present / unavailable</p>"}
    ${lists.map(({ title: listTitle, items }) => `
      <h3>${escapeHtml(listTitle)}</h3>
      ${renderList(items)}
    `).join("")}
  </section>`;
}

export function renderCollapsedDetailsPanel(content) {
  return `<details class="inspection-details">
    <summary>Details</summary>
    ${content}
  </details>`;
}

export function renderSnapshotStateLabel(snapshot) {
  if (!snapshot) {
    return "unavailable";
  }
  if (snapshot.sourceMode === "unavailable") {
    return "unavailable";
  }
  if (Array.isArray(snapshot.markers?.conflicts) && snapshot.markers.conflicts.length > 0) {
    return "conflicting";
  }
  if (snapshot.sourceMode === "checkpoint-only") {
    return "checkpoint-only";
  }
  if (snapshot.sourceMode === "partial") {
    return "degraded";
  }
  return "authoritative";
}

export function formatStateToken(value, fallback = "not present") {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

export function humanizeStateToken(value) {
  const token = formatStateToken(value, "not present");
  if (token === "not present") {
    return token;
  }
  return token.replaceAll("_", " ");
}

export function titleCaseWords(value) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function renderTargetKey(target) {
  if (!target || target.pr === null || target.pr === undefined) {
    return "";
  }
  const normalizedRepo = tryNormalizeRepoSlug(target.repo);
  if (normalizedRepo === null) {
    return "";
  }
  return `${normalizedRepo}#${target.pr}`;
}

const VALID_INBOX_SIGNALS = new Set(["attention", "pending", "gate", "ready", "closed", "unknown", "waiting"]);

export function normalizeInboxSignal(signal, fallback = "unknown") {
  const normalized = typeof signal === "string" ? signal.trim().toLowerCase() : "";
  return VALID_INBOX_SIGNALS.has(normalized) ? normalized : fallback;
}
