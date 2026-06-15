import {
  DEFAULT_INBOX_MODE,
  DEFAULT_INBOX_PAGE,
  DEFAULT_INBOX_PR_STATE,
  DEFAULT_INBOX_UPDATED_WITHIN_DAYS,
  INBOX_MODE_FILTER_PRESETS,
  INBOX_STATE_FILTER_PRESETS,
  INBOX_UPDATED_FILTER_PRESETS,
} from "./constants.mjs";
import { dedupeRepoSlugOptions, repoSlugEquals } from "@dev-loops/core/github/repo-slug";
import {
  escapeHtml,
  formatStateToken,
  normalizeInboxSignal,
  renderSnapshotStateLabel,
  renderTargetKey,
} from "./shared.mjs";
import { deriveInboxSignalFromSnapshot, summarizeCurrentPrStatus } from "./status.mjs";

function formatInboxUpdatedAt(updatedAt) {
  if (typeof updatedAt !== "string" || updatedAt.trim().length === 0) {
    return "updated unknown";
  }
  const parsed = Date.parse(updatedAt);
  if (Number.isNaN(parsed)) {
    return `updated ${updatedAt.trim()}`;
  }
  return `updated ${new Date(parsed).toISOString().slice(0, 10)}`;
}

function inboxSignalEmoji(signal) {
  switch (signal) {
    case "ready": return "✅";
    case "attention": return "🔴";
    case "waiting": return "⏳";
    case "pending": return "🔄";
    case "gate": return "🛡️";
    case "closed": return "✖️";
    default: return "❓";
  }
}

function describeInboxSignal(signal) {
  switch (signal) {
    case "attention":
      return { label: "Needs attention", shortLabel: "Attention" };
    case "pending":
      return { label: "CI pending", shortLabel: "CI" };
    case "gate":
      return { label: "Gate review required", shortLabel: "Gate" };
    case "ready":
      return { label: "Ready", shortLabel: "Ready" };
    case "closed":
      return { label: "Closed", shortLabel: "Closed" };
    case "unknown":
      return { label: "State unavailable", shortLabel: "Unknown" };
    case "waiting":
    default:
      return { label: "Waiting", shortLabel: "Waiting" };
  }
}

function summarizeInboxRow(snapshot, fallbackSignal = "unknown") {
  const normalizedFallbackSignal = normalizeInboxSignal(fallbackSignal);
  const signal = normalizedFallbackSignal !== "unknown"
    ? normalizedFallbackSignal
    : snapshot
      ? deriveInboxSignalFromSnapshot(snapshot)
      : normalizedFallbackSignal;
  if (!snapshot) {
    return {
      signal,
      signalLabel: describeInboxSignal(signal),
      statusClass: null,
      trustLabel: null,
      needsAttention: signal === "attention",
      headline: null,
    };
  }

  return {
    signal,
    signalLabel: describeInboxSignal(signal),
    statusClass: formatStateToken(snapshot.statusClass, "unknown"),
    trustLabel: renderSnapshotStateLabel(snapshot),
    needsAttention: snapshot.needsAttention === true,
    headline: summarizeCurrentPrStatus(snapshot).headline,
  };
}

function appendInboxViewParams(params, {
  selectedTarget = null,
  scopeFilter = null,
  updatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS,
  state = DEFAULT_INBOX_PR_STATE,
  mode = DEFAULT_INBOX_MODE,
  page = DEFAULT_INBOX_PAGE,
} = {}) {
  if (typeof scopeFilter === "string" && scopeFilter.trim().length > 0) {
    params.set("scope", scopeFilter.trim());
  }
  if (selectedTarget?.repo !== undefined && selectedTarget?.repo !== null) {
    params.set("repo", String(selectedTarget.repo));
  }
  if (selectedTarget?.pr !== undefined && selectedTarget?.pr !== null) {
    params.set("pr", String(selectedTarget.pr));
  }
  if (updatedWithinDays === null) {
    params.set("updated", "all");
  } else if (updatedWithinDays !== DEFAULT_INBOX_UPDATED_WITHIN_DAYS) {
    params.set("updated", String(updatedWithinDays));
  }
  if (page > DEFAULT_INBOX_PAGE) {
    params.set("page", String(page));
  }
  params.set("state", state);
  params.set("mode", mode);
}

function buildInboxHref(target, { scopeFilter = null, updatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS, state = DEFAULT_INBOX_PR_STATE, mode = DEFAULT_INBOX_MODE, page = DEFAULT_INBOX_PAGE } = {}) {
  const params = new URLSearchParams();
  appendInboxViewParams(params, { selectedTarget: target, scopeFilter, updatedWithinDays, state, mode, page });
  return `/?${params.toString()}`;
}

export function buildSnapshotHref(target, scopeFilter = null) {
  if (!target) {
    return null;
  }
  const params = new URLSearchParams();
  appendInboxViewParams(params, { selectedTarget: target, scopeFilter, updatedWithinDays: DEFAULT_INBOX_UPDATED_WITHIN_DAYS, state: DEFAULT_INBOX_PR_STATE, mode: DEFAULT_INBOX_MODE, page: DEFAULT_INBOX_PAGE });
  params.delete("scope");
  params.delete("updated");
  params.delete("limit");
  params.delete("state");
  params.delete("mode");
  return `/snapshot.json?${params.toString()}`;
}

function renderInboxFilterHref(selectedTarget, { scopeFilter = null, updatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS, state = DEFAULT_INBOX_PR_STATE, mode = DEFAULT_INBOX_MODE, page = DEFAULT_INBOX_PAGE } = {}) {
  const params = new URLSearchParams();
  appendInboxViewParams(params, { selectedTarget, scopeFilter, updatedWithinDays, state, mode, page });
  const query = params.toString();
  return query.length === 0 ? "/" : `/?${query}`;
}

function renderScopeSelectHref(selectedTarget, scopeFilter, { updatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS, state = DEFAULT_INBOX_PR_STATE, mode = DEFAULT_INBOX_MODE } = {}) {
  const retainedTarget = selectedTarget && (scopeFilter === null || repoSlugEquals(selectedTarget.repo, scopeFilter))
    ? selectedTarget
    : null;
  return renderInboxFilterHref(retainedTarget, { scopeFilter, updatedWithinDays, state, mode, page: DEFAULT_INBOX_PAGE });
}

function renderInboxPageHref(selectedTarget, { scopeFilter = null, updatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS, state = DEFAULT_INBOX_PR_STATE, mode = DEFAULT_INBOX_MODE, page = DEFAULT_INBOX_PAGE } = {}) {
  return renderInboxFilterHref(selectedTarget, { scopeFilter, updatedWithinDays, state, mode, page });
}

function renderInboxPagination({ selectedTarget = null, scopeFilter = null, updatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS, state = DEFAULT_INBOX_PR_STATE, mode = DEFAULT_INBOX_MODE, page = DEFAULT_INBOX_PAGE, totalPages = 1 } = {}) {
  if (totalPages <= 1) {
    return "";
  }

  const previousPage = Math.max(DEFAULT_INBOX_PAGE, page - 1);
  const nextPage = Math.min(totalPages, page + 1);

  return `<nav class="assigned-pr-pagination" aria-label="Sidebar pagination">
    <a class="assigned-pr-page-link ${page <= DEFAULT_INBOX_PAGE ? "is-disabled" : ""}" href="${escapeHtml(renderInboxPageHref(selectedTarget, { scopeFilter, updatedWithinDays, state, mode, page: previousPage }))}" aria-label="Previous page" ${page <= DEFAULT_INBOX_PAGE ? 'aria-disabled="true" tabindex="-1"' : ""}>←</a>
    <span class="assigned-pr-page-status">${escapeHtml(String(page))}/${escapeHtml(String(totalPages))}</span>
    <a class="assigned-pr-page-link ${page >= totalPages ? "is-disabled" : ""}" href="${escapeHtml(renderInboxPageHref(selectedTarget, { scopeFilter, updatedWithinDays, state, mode, page: nextPage }))}" aria-label="Next page" ${page >= totalPages ? 'aria-disabled="true" tabindex="-1"' : ""}>→</a>
  </nav>`;
}

export function renderInboxSidebar(items, selectedTarget, { scopeFilter = null, scopeOptions = [], updatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS, state = DEFAULT_INBOX_PR_STATE, mode = DEFAULT_INBOX_MODE, page = DEFAULT_INBOX_PAGE, totalPages = 1 } = {}) {
  const selectedKey = renderTargetKey(selectedTarget);
  const uniqueScopeOptions = ["All repos", ...dedupeRepoSlugOptions(scopeOptions)].sort((left, right) => {
    if (left === "All repos") {
      return -1;
    }
    if (right === "All repos") {
      return 1;
    }
    return left.localeCompare(right);
  });
  return `<aside class="assigned-pr-inbox" data-sidebar-collapsed="false">
    <div class="assigned-pr-inbox-header">
      <h2>PR inspection dashboard</h2>
      <button type="button" class="inbox-collapse-toggle" data-inbox-toggle aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar">◀</button>
    </div>
    <div class="assigned-pr-controls">
      <div class="assigned-pr-control-row assigned-pr-scope-row">
        <label class="assigned-pr-filter-label" for="assigned-pr-scope-select">Scope</label>
        <select id="assigned-pr-scope-select" class="assigned-pr-select" data-nav-select>
          ${uniqueScopeOptions.map((option) => {
    const optionScope = option === "All repos" ? null : option;
    const selected = optionScope === null ? scopeFilter === null : repoSlugEquals(optionScope, scopeFilter);
    return `<option value="${escapeHtml(renderScopeSelectHref(selectedTarget, optionScope, { updatedWithinDays, state, mode }))}" ${selected ? "selected" : ""}>${escapeHtml(option)}</option>`;
  }).join("")}
        </select>
      </div>
      <div class="assigned-pr-control-row assigned-pr-secondary-controls">
        <label class="assigned-pr-filter-label" for="assigned-pr-state-select">State</label>
        <select id="assigned-pr-mode-select" class="assigned-pr-select assigned-pr-select-mid" data-nav-select aria-label="Assignment mode">
          ${INBOX_MODE_FILTER_PRESETS.map((preset) => {
    const selected = preset.value === mode;
    return `<option value="${escapeHtml(renderInboxFilterHref(selectedTarget, { scopeFilter, updatedWithinDays, state, mode: preset.value, page: DEFAULT_INBOX_PAGE }))}" ${selected ? "selected" : ""}>${escapeHtml(preset.label)}</option>`;
  }).join("")}
        </select>
        <select id="assigned-pr-state-select" class="assigned-pr-select assigned-pr-select-mid" data-nav-select>
          ${INBOX_STATE_FILTER_PRESETS.map((preset) => {
    const selected = preset.value === state;
    return `<option value="${escapeHtml(renderInboxFilterHref(selectedTarget, { scopeFilter, updatedWithinDays, state: preset.value, mode, page: DEFAULT_INBOX_PAGE }))}" ${selected ? "selected" : ""}>${escapeHtml(preset.label)}</option>`;
  }).join("")}
        </select>
        <select id="assigned-pr-updated-select" class="assigned-pr-select assigned-pr-select-sm assigned-pr-select-updated" data-nav-select aria-label="Updated window">
          ${INBOX_UPDATED_FILTER_PRESETS.map((preset) => {
    const selected = preset.value === updatedWithinDays;
    return `<option value="${escapeHtml(renderInboxFilterHref(selectedTarget, { scopeFilter, updatedWithinDays: preset.value, state, mode, page: DEFAULT_INBOX_PAGE }))}" ${selected ? "selected" : ""}>${escapeHtml(preset.label)}</option>`;
  }).join("")}
        </select>
      </div>
    </div>
    <label class="inbox-search-label" for="inbox-search">Search PRs</label>
    <input id="inbox-search" class="inbox-search-input" type="search" placeholder="Search PR # or title…" data-inbox-search />
    <ul class="assigned-pr-list" data-inbox-list>
      ${items.map((item) => {
    const summary = summarizeInboxRow(item.snapshot ?? null, item.signal ?? "unknown");
    const target = item.target;
    const key = renderTargetKey(target);
    const selected = key === selectedKey;
    const searchText = `${target.repo} #${target.pr} ${item.title ?? ""} ${summary.signalLabel.label} ${summary.statusClass ?? ""} ${summary.trustLabel ?? ""} ${summary.headline ?? ""} ${item.updatedAt ?? ""}`.toLowerCase();
    return `<li class="assigned-pr-row assigned-pr-row-${escapeHtml(summary.signal)} ${selected ? "is-selected" : ""}" data-inbox-item data-inbox-signal="${escapeHtml(summary.signal)}" data-search="${escapeHtml(searchText)}">
          <a class="assigned-pr-link" href="${escapeHtml(buildInboxHref(target, { scopeFilter, updatedWithinDays, state, mode, page }))}" ${selected ? 'aria-current="page"' : ""}>
            <div class="assigned-pr-line assigned-pr-title-line">
              <span class="assigned-pr-id-col">
                <span class="assigned-pr-id">#${escapeHtml(String(target.pr))}</span>
                <span class="assigned-pr-signal-emoji" aria-label="${escapeHtml(summary.signalLabel.label)}">${inboxSignalEmoji(summary.signal)}</span>
              </span>
              <span class="assigned-pr-title">${escapeHtml(item.title ?? "Untitled pull request")}</span>
            </div>
            <div class="assigned-pr-line assigned-pr-meta assigned-pr-meta-primary">
              ${scopeFilter === null ? `<span class="assigned-pr-repo">${escapeHtml(target.repo)}</span>` : ""}
              <span class="assigned-pr-updated">${escapeHtml(formatInboxUpdatedAt(item.updatedAt))}</span>
            </div>
            <div class="assigned-pr-line assigned-pr-meta assigned-pr-meta-secondary">
              ${summary.statusClass ? `<span class="assigned-pr-status">${escapeHtml(summary.statusClass)}</span>` : ""}
              ${summary.trustLabel ? `<span class="assigned-pr-trust">${escapeHtml(summary.trustLabel)}</span>` : ""}
              ${summary.headline ? `<span class="assigned-pr-headline">${escapeHtml(summary.headline)}</span>` : ""}
            </div>
          </a>
        </li>`;
  }).join("")}
    </ul>
    <p class="assigned-pr-empty" data-inbox-empty data-empty-default="No assigned PRs are visible in this view." data-empty-search="No assigned PRs match this search." hidden>No assigned PRs are visible in this view.</p>
    ${renderInboxPagination({ selectedTarget, scopeFilter, updatedWithinDays, state, mode, page, totalPages })}
  </aside>`;
}

export function renderInboxShellScript() {
  return `<script>
    (() => {
      const sidebar = document.querySelector(".assigned-pr-inbox");
      const toggle = document.querySelector("[data-inbox-toggle]");
      const search = document.querySelector("[data-inbox-search]");
      const navSelects = Array.from(document.querySelectorAll("[data-nav-select]"));
      const items = Array.from(document.querySelectorAll("[data-inbox-item]"));
      const empty = document.querySelector("[data-inbox-empty]");
      const updateFilter = () => {
        const query = (search?.value ?? "").trim().toLowerCase();
        let visibleCount = 0;
        items.forEach((item) => {
          const haystack = item.getAttribute("data-search") ?? "";
          const visible = query.length === 0 || haystack.includes(query);
          item.hidden = !visible;
          if (visible) {
            visibleCount += 1;
          }
        });
        if (empty) {
          const defaultMessage = empty.dataset.emptyDefault ?? "No assigned PRs are visible in this view.";
          const searchMessage = empty.dataset.emptySearch ?? "No assigned PRs match this search.";
          empty.textContent = query.length === 0 ? defaultMessage : searchMessage;
          empty.hidden = visibleCount !== 0;
        }
      };
      toggle?.addEventListener("click", () => {
        const collapsed = sidebar?.dataset.sidebarCollapsed === "true";
        if (!sidebar) {
          return;
        }
        sidebar.dataset.sidebarCollapsed = collapsed ? "false" : "true";
        toggle.textContent = collapsed ? "◀" : "▶";
        toggle.setAttribute("aria-label", collapsed ? "Collapse sidebar" : "Expand sidebar");
        toggle.setAttribute("title", collapsed ? "Collapse sidebar" : "Expand sidebar");
        toggle.setAttribute("aria-expanded", collapsed ? "true" : "false");
      });
      search?.addEventListener("input", updateFilter);
      navSelects.forEach((select) => {
        select.addEventListener("change", () => {
          const href = select.value;
          if (typeof href === "string" && href.length > 0) {
            window.location.assign(href);
          }
        });
      });
      updateFilter();
    })();
  </script>`;
}
