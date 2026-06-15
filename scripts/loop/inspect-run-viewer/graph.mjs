import { readFile } from "node:fs/promises";

import {
  MERMAID_BROWSER_ASSET_PATH,
  MERMAID_BROWSER_ASSET_ROUTE,
} from "./constants.mjs";
import {
  STATE as COPILOT_STATE,
  TRANSITIONS as COPILOT_TRANSITIONS,
} from "../../../packages/core/src/loop/copilot-loop-state.mjs";
import {
  OUTER_GRAPH,
  OUTER_STATE,
  OUTER_TERMINAL_STATES,
  OUTER_TRANSITIONS,
} from "../../../packages/core/src/loop/conductor-routing.mjs";
import {
  REVIEWER_STATE,
  REVIEWER_TRANSITIONS,
} from "../../../packages/core/src/loop/reviewer-loop-state.mjs";
import {
  LIFECYCLE_GRAPH,
  LIFECYCLE_STATE,
  LIFECYCLE_TERMINAL_STATES,
  LIFECYCLE_TRANSITIONS,
} from "../../../packages/core/src/loop/lifecycle-state.mjs";
import {
  escapeHtml,
  formatStateToken,
  renderSnapshotStateLabel,
} from "./shared.mjs";

let mermaidBrowserScriptPromise = null;

function normalizeTransitions(transitions) {
  if (!Array.isArray(transitions)) {
    return null;
  }

  const normalizedTransitions = [];
  const seenTransitions = new Set();

  for (const transition of transitions) {
    if (typeof transition !== "string") {
      continue;
    }

    const normalizedTransition = transition.trim();
    if (normalizedTransition.length === 0 || seenTransitions.has(normalizedTransition)) {
      continue;
    }

    seenTransitions.add(normalizedTransition);
    normalizedTransitions.push(normalizedTransition);
  }

  return normalizedTransitions;
}

const COPILOT_TERMINAL_STATES = new Set(
  Object.entries(COPILOT_TRANSITIONS)
    .filter(([, nextStates]) => Array.isArray(nextStates) && nextStates.length === 0)
    .map(([state]) => state),
);
const OUTER_TERMINAL_STATE_SET = new Set(OUTER_TERMINAL_STATES);
const REVIEWER_TERMINAL_STATES = new Set(
  Object.entries(REVIEWER_TRANSITIONS)
    .filter(([, nextStates]) => Array.isArray(nextStates) && nextStates.length === 0)
    .map(([state]) => state),
);

const LIFECYCLE_TERMINAL_STATE_SET = new Set(LIFECYCLE_TERMINAL_STATES);

function normalizeCurrentStateInfo(currentState, { knownStates = null, terminalStates = null } = {}) {
  if (typeof currentState === "string" && currentState.length > 0) {
    const normalized = currentState.trim();

    if (normalized.toLowerCase() === "unknown") {
      return { label: "current state unavailable", available: false, terminal: false };
    }
    if (knownStates instanceof Set && !knownStates.has(normalized)) {
      return { label: "current state unavailable", available: false, terminal: false };
    }

    return {
      label: normalized,
      available: true,
      terminal: terminalStates instanceof Set ? terminalStates.has(normalized) : false,
    };
  }

  return { label: "current state unavailable", available: false, terminal: false };
}

function summarizeTransitionAvailability(transitions) {
  const normalizedTransitions = normalizeTransitions(transitions);
  const unavailable = normalizedTransitions === null;
  const empty = !unavailable && normalizedTransitions.length === 0;
  const summary = unavailable
    ? "transition data unavailable in this snapshot"
    : empty
      ? "no allowed transitions"
      : normalizedTransitions.join(", ");

  return {
    unavailable,
    empty,
    summary,
    normalizedTransitions: unavailable ? [] : normalizedTransitions,
  };
}

export async function loadMermaidBrowserScript({ readFileImpl = readFile } = {}) {
  if (mermaidBrowserScriptPromise === null) {
    mermaidBrowserScriptPromise = Promise.resolve()
      .then(() => readFileImpl(MERMAID_BROWSER_ASSET_PATH, "utf8"))
      .catch((error) => {
        mermaidBrowserScriptPromise = null;
        throw error;
      });
  }
  return mermaidBrowserScriptPromise;
}

export function resetMermaidBrowserScriptCache() {
  mermaidBrowserScriptPromise = null;
}

function escapeMermaidLabel(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function renderMermaidNode(id, label, shape = "box") {
  const escapedLabel = escapeMermaidLabel(label);

  if (shape === "pill") {
    return `${id}(["${escapedLabel}"])`;
  }
  if (shape === "circle") {
    return `${id}(("${escapedLabel}"))`;
  }

  return `${id}["${escapedLabel}"]`;
}

function renderMermaidNodeId(laneKey, state) {
  return `${laneKey}_${String(state).replaceAll(/[^a-zA-Z0-9_]+/g, "_")}`;
}

function humanizeGraphStateLabel(state) {
  return String(state).replaceAll("_", " ");
}

function buildFullStateMachineLane({ laneKey, title, states, transitionTable, currentState, transitions, startStates = [], startLabel = "Start", endLabel = "End", terminalStates = null, displayLabelForState = (state) => state, suppressSaturatedNextHighlights = false }) {
  const knownStates = new Set(states);
  const resolvedTerminalStates = terminalStates instanceof Set
    ? terminalStates
    : new Set(states.filter((state) => Array.isArray(transitionTable[state]) && transitionTable[state].length === 0));
  const currentInfo = normalizeCurrentStateInfo(currentState, { knownStates, terminalStates: resolvedTerminalStates });
  const transitionInfo = summarizeTransitionAvailability(transitions);
  const authoritativeCurrentNextStates = currentInfo.available
    ? new Set(Array.isArray(transitionTable[currentInfo.label]) ? transitionTable[currentInfo.label] : [])
    : new Set();
  const highlightedNextStates = new Set(
    transitionInfo.unavailable || !currentInfo.available
      ? []
      : transitionInfo.normalizedTransitions.filter((state) => authoritativeCurrentNextStates.has(state)),
  );
  const broadNextSet = suppressSaturatedNextHighlights
    && currentInfo.available
    && highlightedNextStates.size === knownStates.size;
  const effectiveHighlightedNextStates = broadNextSet ? new Set() : highlightedNextStates;
  const classIds = {
    cue: [],
    current: [],
    currentTerminal: [],
    next: [],
    nextTerminal: [],
    terminal: [],
    inactive: [],
    unavailable: [],
    note: [],
  };
  const lines = [
    `  subgraph ${laneKey}["${escapeMermaidLabel(title)}"]`,
    "    direction LR",
  ];
  const startId = `${laneKey}_start`;
  const endId = `${laneKey}_end`;

  if (startStates.length > 0) {
    lines.push(`    ${renderMermaidNode(startId, startLabel, "pill")}`);
    classIds.cue.push(startId);
  }

  for (const state of states) {
    const nodeId = renderMermaidNodeId(laneKey, state);
    const terminal = resolvedTerminalStates.has(state);
    lines.push(`    ${renderMermaidNode(nodeId, displayLabelForState(state))}`);

    if (currentInfo.available && currentInfo.label === state) {
      classIds[terminal ? "currentTerminal" : "current"].push(nodeId);
    } else if (effectiveHighlightedNextStates.has(state)) {
      classIds[terminal ? "nextTerminal" : "next"].push(nodeId);
    } else if (terminal) {
      classIds.terminal.push(nodeId);
    } else {
      classIds.inactive.push(nodeId);
    }
  }

  let endVisible = false;
  const ensureEndNode = () => {
    if (!endVisible) {
      lines.push(`    ${renderMermaidNode(endId, endLabel, "circle")}`);
      classIds.cue.push(endId);
      endVisible = true;
    }
    return endId;
  };

  for (const startState of startStates) {
    if (knownStates.has(startState)) {
      lines.push(`    ${startId} --> ${renderMermaidNodeId(laneKey, startState)}`);
    }
  }

  for (const state of states) {
    const fromId = renderMermaidNodeId(laneKey, state);
    const nextStates = Array.isArray(transitionTable[state]) ? transitionTable[state] : [];

    if (nextStates.length === 0) {
      lines.push(`    ${fromId} --> ${ensureEndNode()}`);
      continue;
    }

    for (const nextState of nextStates) {
      if (knownStates.has(nextState)) {
        lines.push(`    ${fromId} --> ${renderMermaidNodeId(laneKey, nextState)}`);
      }
    }
  }

  let currentId = startStates.length > 0 ? startId : renderMermaidNodeId(laneKey, states[0]);
  if (!currentInfo.available) {
    const unavailableId = `${laneKey}_current_unavailable`;
    lines.push(`    ${renderMermaidNode(unavailableId, currentInfo.label)}`);
    classIds.unavailable.push(unavailableId);
    currentId = unavailableId;
  } else {
    currentId = renderMermaidNodeId(laneKey, currentInfo.label);
  }

  if (transitionInfo.unavailable) {
    const noteId = `${laneKey}_transitions_unavailable`;
    lines.push(`    ${renderMermaidNode(noteId, "snapshot next transitions unavailable")}`);
    lines.push(`    ${currentId} -.-> ${noteId}`);
    classIds.note.push(noteId);
  } else if (broadNextSet) {
    const noteId = `${laneKey}_broad_next_set`;
    lines.push(`    ${renderMermaidNode(noteId, "next evaluation may resolve to any shown state")}`);
    lines.push(`    ${currentId} -.-> ${noteId}`);
    classIds.note.push(noteId);
  }

  lines.push("  end");

  return {
    title,
    currentLabel: currentInfo.label,
    transitionInfo,
    currentId,
    lines,
    classIds,
    summary: `${currentInfo.label}; full authoritative state machine shown`,
  };
}

export function buildInspectionMermaidGraph(snapshot) {
  if (snapshot === null || snapshot === undefined || renderSnapshotStateLabel(snapshot) === "unavailable") {
    return null;
  }

  const lanes = [
    buildFullStateMachineLane({
      laneKey: "outer_loop_family",
      title: "outer-loop family",
      states: Object.values(OUTER_STATE),
      transitionTable: OUTER_TRANSITIONS,
      currentState: snapshot.outerState,
      transitions: snapshot.allowedTransitions,
      startStates: OUTER_GRAPH.entryStates,
      startLabel: OUTER_GRAPH.start.label,
      endLabel: OUTER_GRAPH.end.label,
      terminalStates: OUTER_TERMINAL_STATE_SET,
      displayLabelForState: humanizeGraphStateLabel,
      suppressSaturatedNextHighlights: true,
    }),
    buildFullStateMachineLane({
      laneKey: "copilot_layer",
      title: "copilot layer",
      states: Object.values(COPILOT_STATE),
      transitionTable: COPILOT_TRANSITIONS,
      currentState: snapshot.layers?.copilot?.currentState,
      transitions: snapshot.layers?.copilot?.allowedTransitions,
      startStates: [COPILOT_STATE.PR_DRAFT],
      terminalStates: COPILOT_TERMINAL_STATES,
    }),
    buildFullStateMachineLane({
      laneKey: "reviewer_layer",
      title: "reviewer layer",
      states: Object.values(REVIEWER_STATE),
      transitionTable: REVIEWER_TRANSITIONS,
      currentState: snapshot.layers?.reviewer?.currentState,
      transitions: snapshot.layers?.reviewer?.allowedTransitions,
      startStates: [REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST],
      terminalStates: REVIEWER_TERMINAL_STATES,
    }),
    buildFullStateMachineLane({
      laneKey: "lifecycle_layer",
      title: "lifecycle",
      states: Object.values(LIFECYCLE_STATE),
      transitionTable: LIFECYCLE_TRANSITIONS,
      currentState: snapshot.lifecyclePhase,
      transitions: snapshot.lifecycleAllowedTransitions,
      startStates: LIFECYCLE_GRAPH.entryStates,
      startLabel: LIFECYCLE_GRAPH.start.label,
      endLabel: LIFECYCLE_GRAPH.end.label,
      terminalStates: LIFECYCLE_TERMINAL_STATE_SET,
      displayLabelForState: humanizeGraphStateLabel,
    }),
  ];

  const classIds = {
    cue: [],
    current: [],
    currentTerminal: [],
    next: [],
    nextTerminal: [],
    terminal: [],
    inactive: [],
    unavailable: [],
    note: [],
  };

  for (const lane of lanes) {
    for (const [className, ids] of Object.entries(lane.classIds)) {
      classIds[className].push(...ids);
    }
  }

  const orderedLaneLines = [
    '  subgraph lane_stack[" "]',
    '    direction TB',
    ...lanes.flatMap((lane) => lane.lines.map((line) => `    ${line.trimStart()}`)),
    '  end',
  ];

  const lines = [
    "flowchart TB",
    "  classDef cue fill:#f5f7f9,stroke:#78909c,stroke-width:1.5px,color:#355061,font-weight:bold;",
    "  classDef current fill:#e3f2fd,stroke:#1565c0,stroke-width:4px,color:#12344d,font-weight:bold;",
    "  classDef currentTerminal fill:#d9f2df,stroke:#1565c0,stroke-width:4px,color:#12344d,font-weight:800;",
    "  classDef next fill:#f3f4ff,stroke:#5c6bc0,stroke-width:2px,color:#233242,font-weight:700;",
    "  classDef nextTerminal fill:#eef7ef,stroke:#5c6bc0,stroke-width:3px,color:#1b5e20,font-weight:700;",
    "  classDef terminal fill:#e8f5e9,stroke:#2e7d32,stroke-width:3px,color:#1b5e20,font-weight:bold;",
    "  classDef inactive fill:#ffffff,stroke:#b0bec5,stroke-width:1.5px,color:#607d8b;",
    "  classDef unavailable fill:#f8fafc,stroke:#90a4ae,stroke-width:2px,color:#546e7a,stroke-dasharray: 6 4;",
    "  classDef note fill:#fff3e0,stroke:#ef6c00,stroke-width:2px,color:#7f4b00;",
    ...orderedLaneLines,
    '  outer_loop_family_start ~~~ copilot_layer_start',
    '  copilot_layer_start ~~~ reviewer_layer_start',
    '  reviewer_layer_start ~~~ lifecycle_layer_start',
    '  outer_loop_family_start ~~~ lifecycle_layer_start',
    `  ${lanes[0].currentId} -. "layer view" .-> ${lanes[1].currentId}`,
    `  ${lanes[1].currentId} -. "layer view" .-> ${lanes[2].currentId}`,
    `  ${lanes[2].currentId} -. "layer view" .-> ${lanes[3].currentId}`,
  ];

  for (const [className, ids] of Object.entries(classIds)) {
    if (ids.length > 0) {
      lines.push(`  class ${ids.join(",")} ${className};`);
    }
  }

  const outerState = formatStateToken(snapshot.outerState, "unknown");
  const outerAction = formatStateToken(snapshot.outerAction, "unknown");
  let focusIds = lanes.map((lane) => lane.currentId);
  const lifecycleAvailable = snapshot.lifecyclePhase != null
    && snapshot.lifecyclePhase !== "unknown"
    && !String(snapshot.lifecyclePhase).toLowerCase().includes("unavailable");
  if (lifecycleAvailable) {
    focusIds = [lanes[3].currentId];
  } else if (outerState === OUTER_STATE.HANDOFF_TO_COPILOT_LOOP || outerAction === "reenter_copilot_loop") {
    focusIds = [lanes[1].currentId];
  } else if (outerState === OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP || outerAction === "reenter_reviewer_loop") {
    focusIds = [lanes[2].currentId];
  } else {
    const copilotFocusId = lanes[1].currentId;
    const copilotAvailable = !copilotFocusId.includes("unavailable");
    focusIds = copilotAvailable ? [copilotFocusId] : lanes.map((lane) => lane.currentId);
  }

  return {
    definition: lines.join("\n"),
    focusIds,
    lanes: lanes.map((lane) => ({
      title: lane.title,
      currentLabel: lane.currentLabel,
      transitionInfo: lane.transitionInfo,
      summary: lane.summary,
    })),
  };
}

function renderStateGraphLegend() {
  return `<div class="state-graph-cues" aria-label="State graph cues">
    <span class="state-graph-cue"><span class="state-graph-cue-chip state-graph-cue-chip-start">Start</span> lane entry</span>
    <span class="state-graph-cue"><span class="state-graph-cue-chip state-graph-cue-chip-current">Current</span> snapshot-derived current state</span>
    <span class="state-graph-cue"><span class="state-graph-cue-chip state-graph-cue-chip-next">Next</span> immediate allowed next state</span>
    <span class="state-graph-cue"><span class="state-graph-cue-chip state-graph-cue-chip-end">End</span> terminal / no-transition outcome</span>
    <span class="state-graph-cue"><span class="state-graph-cue-chip state-graph-cue-chip-loop">🔁</span> manual re-inspection cue</span>
  </div>`;
}

function renderStateGraphHelp() {
  return `<ul class="state-graph-help">
    <li><strong>Current:</strong> emphasized nodes show the snapshot-derived current state for each lane when that state is actually known.</li>
    <li><strong>Next:</strong> purple nodes mark immediate allowed next states from the snapshot. Dimmed nodes are still part of the authoritative state machine; they are simply inactive right now.</li>
    <li><strong>Start / End:</strong> entry and exit nodes make lane boundaries easier to scan for the full authoritative graph.</li>
    <li><strong>Orchestrator:</strong> the outer lane comes from the shared authoritative outer-loop graph contract; outerAction remains visible only as a compatibility projection.</li>
    <li><strong>Lifecycle:</strong> the lifecycle lane shows the sequential dev-loop phases from issue intake to merge; current phase is highlighted from the inspection snapshot.</li>
    <li><strong>🔁 Loop cue:</strong> this viewer is revisited by manual reload, so the same current state can recur across inspections until evidence changes.</li>
  </ul>`;
}

function renderStateGraphSummaries(graph) {
  return `<ul class="state-graph-summaries">
    ${graph.lanes.map((lane) => `<li class="state-graph-summary"><strong>${escapeHtml(lane.title)}:</strong> current <code>${escapeHtml(lane.currentLabel)}</code>; ${escapeHtml(lane.summary ?? lane.transitionInfo.summary)}; ${escapeHtml(lane.transitionInfo.summary)}</li>`).join("")}
  </ul>`;
}

function renderStateGraphDetails(graph) {
  return `<details class="state-graph-details">
    <summary>Graph guide and lane details</summary>
    ${renderStateGraphHelp()}
    ${renderStateGraphSummaries(graph)}
  </details>`;
}

export function renderMermaidBootScript() {
  return `<script src="${MERMAID_BROWSER_ASSET_ROUTE}"></script>
    <script>
      (() => {
        const frames = Array.from(document.querySelectorAll(".state-graph-frame"));
        const graphs = Array.from(document.querySelectorAll(".mermaid-state-graph"));
        const renderedGraphs = new WeakSet();
        const clampScale = (value) => Math.max(0.5, Math.min(5, value));
        const updateFrameScale = (frame, requestedScale) => {
          const scale = clampScale(requestedScale);
          frame.dataset.graphScale = String(scale);
          const zoomValue = frame.querySelector("[data-graph-zoom-value]");
          if (zoomValue) {
            zoomValue.textContent = String(Math.round(scale * 100)) + "%";
          }
          const graphViewport = frame.querySelector(".mermaid-state-graph");
          const svg = graphViewport ? graphViewport.querySelector("svg") : null;
          if (svg && graphViewport) {
            let wrapper = graphViewport.querySelector(":scope > .mermaid-zoom-inner");
            if (!wrapper) {
              const svgRect = svg.getBoundingClientRect();
              wrapper = document.createElement("div");
              wrapper.className = "mermaid-zoom-inner";
              wrapper.style.transformOrigin = "0 0";
              graphViewport.insertBefore(wrapper, svg);
              wrapper.appendChild(svg);
              svg.style.display = "block";
              svg.style.maxWidth = "none";
              if (svgRect.width > 0) {
                frame.dataset.graphNaturalWidth = String(svgRect.width);
                svg.style.width = svgRect.width + "px";
              }
              if (svgRect.height > 0) {
                frame.dataset.graphNaturalHeight = String(svgRect.height);
                svg.style.height = svgRect.height + "px";
              }
            }
            const naturalWidth = Number(frame.dataset.graphNaturalWidth) || graphViewport.getBoundingClientRect().width;
            const naturalHeight = Number(frame.dataset.graphNaturalHeight) || 256;
            wrapper.style.width = Math.round(naturalWidth * scale) + "px";
            wrapper.style.height = Math.round(naturalHeight * scale) + "px";
            svg.style.transform = "scale(" + scale + ")";
            svg.style.transformOrigin = "0 0";
            void graphViewport.offsetWidth;
          }
          return scale;
        };
        const settleGraphViewport = (delayMs = 180) => new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) {
              return;
            }
            done = true;
            resolve();
          };
          requestAnimationFrame(() => {
            requestAnimationFrame(finish);
          });
          window.setTimeout(finish, delayMs);
        });
        const zoomGraphViewport = (frame, graphViewport, requestedScale, focusPoint = null) => {
          const previousScale = Number(frame.dataset.graphScale || 1);
          const nextScale = updateFrameScale(frame, requestedScale);
          void frame.offsetWidth;
          if (!focusPoint) {
            return settleGraphViewport();
          }
          const scaleRatio = nextScale / previousScale;
          return new Promise((resolve) => {
            requestAnimationFrame(() => {
              const newScrollLeft = (focusPoint.contentX * scaleRatio) - focusPoint.viewportX;
              const newScrollTop = (focusPoint.contentY * scaleRatio) - focusPoint.viewportY;
              graphViewport.scrollLeft = newScrollLeft;
              graphViewport.scrollTop = newScrollTop;
              settleGraphViewport().then(resolve);
            });
          });
        };
        const fitGraphToCurrentState = (frame, graphViewport) => {
          return new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const svg = graphViewport.querySelector("svg");
              if (!svg) {
                resolve(false);
                return;
              }
              const focusIds = (graphViewport.dataset.graphFocusIds ?? "")
                .split(",").map((id) => id.trim()).filter(Boolean);
              const allNodes = Array.from(svg.querySelectorAll(".node"));
              const focusNodes = focusIds.length === 0
                ? []
                : allNodes.filter((node) => focusIds.some((focusId) => node.id.includes(focusId)));
              const targetNodes = focusNodes.length > 0
                ? focusNodes
                : Array.from(svg.querySelectorAll(".node.current, .node.currentTerminal, .node.unavailable"));
              const viewportRect = graphViewport.getBoundingClientRect();
              const targetRects = targetNodes
                .map((node) => node.getBoundingClientRect())
                .filter((rect) => rect.width > 0 && rect.height > 0);
              if (targetRects.length === 0) {
                resolve(false);
                return;
              }
              const [firstRect, ...remainingRects] = targetRects;
              const unionRect = remainingRects.reduce((combined, rect) => ({
                left: Math.min(combined.left, rect.left),
                top: Math.min(combined.top, rect.top),
                right: Math.max(combined.right, rect.right),
                bottom: Math.max(combined.bottom, rect.bottom),
              }), { left: firstRect.left, top: firstRect.top, right: firstRect.right, bottom: firstRect.bottom });
              const unionWidth = unionRect.right - unionRect.left;
              zoomGraphViewport(frame, graphViewport, 3, {
                viewportX: viewportRect.width / 2,
                viewportY: viewportRect.height / 2,
                contentX: graphViewport.scrollLeft + ((unionRect.left - viewportRect.left) + (unionWidth / 2)),
                contentY: graphViewport.scrollTop + ((unionRect.top - viewportRect.top) + ((unionRect.bottom - unionRect.top) / 2)),
              }).then(() => {
                resolve(true);
              });
            }));
          });
        };
        const renderFallback = (message) => {
          graphs.forEach((graph) => {
            const fallback = document.createElement("p");
            fallback.className = "state-graph-render-error";
            fallback.textContent = message;
            graph.replaceWith(fallback);
          });
        };
        const isGraphVisible = (graph) => {
          if (!(graph instanceof HTMLElement)) {
            return false;
          }
          const panel = graph.closest(".tab-content");
          if (panel && !panel.classList.contains("active")) {
            return false;
          }
          const rect = graph.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const finalizeRenderedGraph = async (graph) => {
          graph.dataset.rendered = "settling";
          const frame = graph.closest(".state-graph-frame");
          if (!frame) {
            graph.dataset.rendered = "true";
            renderedGraphs.add(graph);
            return;
          }
          updateFrameScale(frame, Number(frame.dataset.graphScale || 1));
          const graphViewport = frame.querySelector(".mermaid-state-graph");
          if (graphViewport) {
            const focused = await fitGraphToCurrentState(frame, graphViewport);
            if (!focused) {
              await settleGraphViewport();
            }
          } else {
            await settleGraphViewport();
          }
          graph.dataset.rendered = "true";
          renderedGraphs.add(graph);
        };

        frames.forEach((frame) => {
          updateFrameScale(frame, Number(frame.dataset.graphScale || 1));
          frame.querySelector("[data-graph-zoom-in]")?.addEventListener("click", () => {
            updateFrameScale(frame, Number(frame.dataset.graphScale || 1) + 0.25);
          });
          frame.querySelector("[data-graph-zoom-out]")?.addEventListener("click", () => {
            updateFrameScale(frame, Number(frame.dataset.graphScale || 1) - 0.25);
          });
          frame.querySelector("[data-graph-zoom-reset]")?.addEventListener("click", () => {
            updateFrameScale(frame, 1);
          });
          frame.querySelector("[data-graph-fullscreen]")?.addEventListener("click", async () => {
            if (document.fullscreenElement === frame) {
              await document.exitFullscreen?.();
              return;
            }
            await frame.requestFullscreen?.();
          });

          const graphViewport = frame.querySelector(".mermaid-state-graph");
          if (graphViewport) {
            let dragState = null;
            graphViewport.addEventListener("pointerdown", (event) => {
              if (event.button !== 0) {
                return;
              }
              dragState = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startScrollLeft: graphViewport.scrollLeft,
                startScrollTop: graphViewport.scrollTop,
              };
              graphViewport.dataset.dragging = "true";
              graphViewport.setPointerCapture?.(event.pointerId);
              event.preventDefault();
            });
            graphViewport.addEventListener("pointermove", (event) => {
              if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
              }
              graphViewport.scrollLeft = dragState.startScrollLeft - (event.clientX - dragState.startX);
              graphViewport.scrollTop = dragState.startScrollTop - (event.clientY - dragState.startY);
            });
            const stopDragging = (event) => {
              if (!dragState || dragState.pointerId !== event.pointerId) {
                return;
              }
              graphViewport.dataset.dragging = "false";
              graphViewport.releasePointerCapture?.(event.pointerId);
              dragState = null;
            };
            graphViewport.addEventListener("pointerup", stopDragging);
            graphViewport.addEventListener("pointercancel", stopDragging);
            graphViewport.addEventListener("dblclick", (event) => {
              const rect = graphViewport.getBoundingClientRect();
              zoomGraphViewport(
                frame,
                graphViewport,
                Number(frame.dataset.graphScale || 1) + 0.25,
                {
                  viewportX: event.clientX - rect.left,
                  viewportY: event.clientY - rect.top,
                  contentX: graphViewport.scrollLeft + (event.clientX - rect.left),
                  contentY: graphViewport.scrollTop + (event.clientY - rect.top),
                },
              );
              event.preventDefault();
            });
          }
        });

        if (graphs.length === 0) {
          return;
        }
        if (typeof window.mermaid === "undefined") {
          renderFallback("Graph renderer unavailable. Use the details below or open /snapshot.json.");
          return;
        }

        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          flowchart: {
            useMaxWidth: true,
            htmlLabels: false,
            curve: "basis",
          },
        });

        let pendingRender = Promise.resolve();
        const queueVisibleGraphRender = () => {
          pendingRender = pendingRender.then(async () => {
            const visibleGraphs = graphs.filter((graph) => !renderedGraphs.has(graph) && isGraphVisible(graph));
            if (visibleGraphs.length === 0) {
              return;
            }
            await window.mermaid.run({ nodes: visibleGraphs });
            await Promise.all(visibleGraphs.map((graph) => finalizeRenderedGraph(graph)));
          }).catch(() => {
            renderFallback("Could not render graph for this snapshot. Use the details below or open /snapshot.json.");
          });
          return pendingRender;
        };

        document.addEventListener("inspect-run-viewer:tabchange", () => {
          window.requestAnimationFrame(() => {
            void queueVisibleGraphRender();
          });
        });
        window.addEventListener("load", () => {
          void queueVisibleGraphRender();
        });
        void queueVisibleGraphRender();
      })();
    </script>`;
}

export function renderStateVisualizationSection(snapshot, graph = buildInspectionMermaidGraph(snapshot)) {
  if (graph === null) {
    return `<div class="state-graph-block">
      <p>Snapshot unavailable, so no state graph can be rendered yet.</p>
    </div>`;
  }

  return `<div class="state-graph-block">
    <div class="state-graph-frame" data-graph-scale="1">
      <div class="state-graph-toolbar" aria-label="Graph controls">
        <button type="button" data-graph-zoom-out aria-label="Zoom out">−</button>
        <button type="button" data-graph-zoom-in aria-label="Zoom in">+</button>
        <button type="button" data-graph-zoom-reset aria-label="Reset zoom">100%</button>
        <span class="state-graph-zoom-value" data-graph-zoom-value>100%</span>
        <button type="button" data-graph-fullscreen aria-label="Open graph fullscreen">⤢</button>
      </div>
      <div class="mermaid-state-graph mermaid" data-rendered="pending" data-graph-focus-ids="${escapeHtml((graph.focusIds ?? []).join(","))}" aria-label="Mermaid inspection state graph">${escapeHtml(graph.definition)}</div>
    </div>
    ${renderStateGraphLegend()}
    ${renderStateGraphDetails(graph)}
  </div>`;
}
