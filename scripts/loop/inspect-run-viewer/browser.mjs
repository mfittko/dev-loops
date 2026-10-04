const SVG_NS = "http://www.w3.org/2000/svg";
const mounted = new WeakSet();
let markerSequence = 0;

function svgElement(name, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}

function classifications(node) {
  const flags = [];
  if (node.snapshot.current) flags.push("Current");
  if (node.snapshot.next) flags.push("Next");
  if (node.terminal) flags.push("Terminal");
  return flags.length ? flags : ["Inactive"];
}

function indexUnique(entries) {
  if (!Array.isArray(entries)) throw new Error("Incomplete graph data");
  const map = new Map();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || map.has(entry.id)) throw new Error("Duplicate or missing graph identity");
    map.set(entry.id, entry);
  }
  return map;
}

function validateGeometry(layer) {
  const geometry = layer.geometry;
  if (geometry?.status !== "available") throw new Error(geometry?.reason || "Layout unavailable");
  const semanticNodes = indexUnique([...layer.nodes, ...layer.cues]);
  const semanticEdges = indexUnique([...layer.edges, ...layer.cueLinks]);
  const nodes = indexUnique(geometry.nodes);
  const edges = indexUnique(geometry.edges);
  const finite = (values) => values.every(Number.isFinite);
  const bounds = geometry.bounds;
  if (!bounds || !finite([bounds.x, bounds.y, bounds.width, bounds.height]) || bounds.width <= 0 || bounds.height <= 0) throw new Error("Invalid layout bounds");
  if (nodes.size !== semanticNodes.size || edges.size !== semanticEdges.size) throw new Error("Incomplete layout");
  for (const [id, node] of nodes) {
    if (!semanticNodes.has(id) || !finite([node.x, node.y, node.width, node.height]) || node.width <= 0 || node.height <= 0
      || node.x < bounds.x || node.y < bounds.y || node.x + node.width > bounds.x + bounds.width || node.y + node.height > bounds.y + bounds.height
      || !Array.isArray(node.labelLines) || !Array.isArray(node.stateIdLines)) throw new Error("Invalid node geometry");
  }
  const pairs = new Set();
  for (const [id, edge] of semanticEdges) {
    const route = edges.get(id);
    const pair = JSON.stringify([edge.from, edge.to]);
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || pairs.has(pair) || !route || !Array.isArray(route.points) || route.points.length < 2
      || route.points.some((point) => !finite([point.x, point.y]) || point.x < bounds.x || point.y < bounds.y
        || point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height)) throw new Error("Invalid edge geometry");
    pairs.add(pair);
  }
  return { nodes, edges };
}

export function mountInspectionGraph(root, graph) {
  if (mounted.has(root)) return;
  mounted.add(root);
  const viewport = root.querySelector("[data-graph-viewport]");
  const details = root.querySelector("[data-graph-node-details]");
  const status = root.querySelector("[data-graph-status]");
  const zoomValue = root.querySelector("[data-graph-zoom-value]");
  const controls = Object.fromEntries(["zoom-in", "zoom-out", "reset", "fit", "focus", "fullscreen"].map((name) => [name, root.querySelector(`[data-graph-${name}]`)]));
  const layerButtons = [...root.querySelectorAll("[data-graph-layer]")];
  let layer;
  let geometry;
  let world;
  let pendingFit = false;
  let camera = { x: 0, y: 0, scale: 1 };
  let drag = null;
  let suppressClick = false;
  let expanded = false;
  let restoreFocus = null;
  let normalStatus = "";

  function failure(error) {
    world = null;
    geometry = null;
    pendingFit = false;
    drag = null;
    viewport?.replaceChildren();
    viewport?.removeAttribute("data-rendered");
    viewport?.removeAttribute("data-graph-scale");
    if (details) details.textContent = "Graphical selection unavailable. Use the textual state details below.";
    normalStatus = `Graph rendering unavailable: ${error.message}. Textual details and the snapshot link remain usable.`;
    if (status) status.textContent = normalStatus;
    for (const control of Object.values(controls)) if (control) control.disabled = true;
    if (controls.fullscreen && (expanded || document.fullscreenElement === root)) controls.fullscreen.disabled = false;
  }

  function applyCamera() {
    if (!world) return;
    world.setAttribute("transform", `translate(${camera.x} ${camera.y}) scale(${camera.scale})`);
    viewport.dataset.graphScale = String(camera.scale);
    zoomValue.textContent = `${Math.round(camera.scale * 100)}%`;
  }

  function center(x, y, scale) {
    camera = { x: viewport.clientWidth / 2 - x * scale, y: viewport.clientHeight / 2 - y * scale, scale };
    applyCamera();
  }

  function fit() {
    if (!world) return;
    if (!viewport.clientWidth || !viewport.clientHeight) { pendingFit = true; return; }
    pendingFit = false;
    const bounds = layer.geometry.bounds;
    const scale = Math.min((Math.max(1, viewport.clientWidth - 32)) / bounds.width, (Math.max(1, viewport.clientHeight - 32)) / bounds.height, 1);
    center(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, scale);
  }

  function focusNode(id, readable = false) {
    const node = geometry?.nodes.get(id);
    if (!node || !world) return;
    center(node.x + node.width / 2, node.y + node.height / 2, readable ? Math.max(1, camera.scale) : camera.scale);
  }

  function zoom(delta) {
    if (!world) return;
    const scale = Math.max(0.05, Math.min(5, camera.scale + delta));
    const x = (viewport.clientWidth / 2 - camera.x) / camera.scale;
    const y = (viewport.clientHeight / 2 - camera.y) / camera.scale;
    center(x, y, scale);
  }

  function detailRow(label, value) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    return [term, description];
  }

  function selectNode(id) {
    const node = layer.nodes.find((entry) => entry.id === id);
    if (!node || !world) return;
    for (const element of world.querySelectorAll("[data-node-id]")) {
      const selected = element.dataset.nodeId === id;
      element.classList.toggle("selected", selected);
      element.setAttribute("aria-pressed", String(selected));
      element.setAttribute("tabindex", selected ? "0" : "-1");
    }
    const heading = document.createElement("h3");
    heading.textContent = node.label;
    const description = document.createElement("dl");
    const outgoing = layer.edges.filter((edge) => edge.from === id).map((edge) => layer.nodes.find((entry) => entry.id === edge.to).stateId);
    const transitions = layer.transitionInfo;
    description.append(
      ...detailRow("State identifier", node.stateId),
      ...detailRow("Classification", classifications(node).join(" · ")),
      ...detailRow("Authoritative outgoing transitions", outgoing.join(", ") || "None — no authoritative outgoing transitions"),
      ...detailRow("Snapshot transition availability", `${transitions.status}: ${transitions.summary}`),
      ...detailRow("Snapshot allowed transitions", transitions.status === "unavailable" ? "Unavailable" : transitions.normalizedTransitions.join(", ") || "Explicitly empty — no allowed transitions"),
      ...detailRow("Snapshot eligibility for this state", transitions.status === "unavailable" ? "Unavailable" : node.snapshot.allowedNext ? "Included in snapshot allowed transitions" : "Not included in snapshot allowed transitions"),
      ...detailRow("Snapshot next-state emphasis", node.snapshot.next ? "Highlighted next state" : transitions.broadNextSet ? "Broad next set; immediate-next emphasis suppressed" : "Not highlighted as next"),
    );
    details.replaceChildren(heading, description);
  }

  function renderLayer(id) {
    const nextLayer = graph.layers.find((entry) => entry.id === id);
    if (!nextLayer || (layer?.id === id && world)) return;
    layer = nextLayer;
    root.dataset.selectedLayer = id;
    for (const button of layerButtons) button.setAttribute("aria-pressed", String(button.dataset.graphLayer === id));
    try {
      geometry = validateGeometry(layer);
      const svg = svgElement("svg", { class: "inspection-graph-svg", role: "group", "aria-label": `${layer.title} authoritative state graph`, width: "100%", height: "100%" });
      const defs = svgElement("defs");
      const markerId = `inspection-arrow-${++markerSequence}`;
      for (const [suffix, color] of [["", "var(--graph-node-line)"], ["-feedback", "var(--graph-guard)"]]) {
        const marker = svgElement("marker", { id: markerId + suffix, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", markerUnits: "strokeWidth" });
        marker.append(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 Z", fill: color }));
        defs.append(marker);
      }
      svg.append(defs);
      world = svgElement("g", { class: "inspection-graph-world" });
      for (const edge of [...layer.edges, ...layer.cueLinks]) {
        const route = geometry.edges.get(edge.id);
        const from = geometry.nodes.get(edge.from);
        const to = geometry.nodes.get(edge.to);
        const cue = layer.cueLinks.some((entry) => entry.id === edge.id);
        const feedback = !cue && (edge.from === edge.to || to.y <= from.y);
        const path = svgElement("path", {
          class: cue ? "inspection-graph-cue-link" : `inspection-graph-edge${feedback ? " feedback" : ""}`,
          d: route.points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "),
          fill: "none", "marker-end": `url(#${markerId}${feedback ? "-feedback" : ""})`,
        });
        if (!cue) path.dataset.edgeId = edge.id;
        const title = svgElement("title", {}, cue ? "Presentation cue connector" : `${layer.nodes.find((node) => node.id === edge.from).stateId} → ${layer.nodes.find((node) => node.id === edge.to).stateId}`);
        path.append(title);
        world.append(path);
      }
      for (const cue of layer.cues) {
        const card = geometry.nodes.get(cue.id);
        const group = svgElement("g", { class: `inspection-graph-cue ${cue.kind}`, transform: `translate(${card.x} ${card.y})`, role: "img", "aria-label": `${cue.label} — presentation-only ${cue.kind} cue` });
        group.append(svgElement("rect", { width: card.width, height: card.height, rx: 16 }));
        card.labelLines.forEach((line, index) => group.append(svgElement("text", { class: "inspection-graph-cue-label", x: 16, y: 32 + index * 20 }, line)));
        world.append(group);
      }
      for (const node of layer.nodes) {
        const card = geometry.nodes.get(node.id);
        const flags = classifications(node);
        const group = svgElement("g", { class: `inspection-graph-node ${flags.map((flag) => flag.toLowerCase()).join(" ")}`, transform: `translate(${card.x} ${card.y})`, role: "button", tabindex: "-1", "aria-pressed": "false", "aria-label": `${node.label}; ${node.stateId}; ${flags.join(", ")}` });
        group.dataset.nodeId = node.id;
        group.dataset.stateId = node.stateId;
        group.append(svgElement("rect", { class: "inspection-graph-card", width: card.width, height: card.height, rx: 10 }));
        card.labelLines.forEach((line, index) => group.append(svgElement("text", { class: "inspection-graph-label", x: 16, y: 32 + index * 20 }, line)));
        const stateTop = 16 + card.labelLines.length * 20 + 8;
        card.stateIdLines.forEach((line, index) => group.append(svgElement("text", { class: "inspection-graph-state-id", x: 16, y: stateTop + 13 + index * 16 }, line)));
        group.append(svgElement("text", { class: "inspection-graph-chip", x: 16, y: stateTop + card.stateIdLines.length * 16 + 27 }, flags.join(" · ")));
        group.addEventListener("click", () => { if (!suppressClick) selectNode(node.id); });
        group.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(node.id); }
          if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const index = layer.nodes.indexOf(node);
            const targetIndex = event.key === "Home" ? 0 : event.key === "End" ? layer.nodes.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + layer.nodes.length) % layer.nodes.length;
            const target = layer.nodes[targetIndex];
            selectNode(target.id);
            focusNode(target.id);
            [...world.querySelectorAll("[data-node-id]")].find((element) => element.dataset.nodeId === target.id).focus({ preventScroll: true });
          }
        });
        world.append(group);
      }
      svg.append(world);
      viewport.replaceChildren(svg);
      for (const control of Object.values(controls)) control.disabled = false;
      controls.focus.disabled = layer.current.status !== "known";
      const focusReason = layer.current.status === "known" ? "Center the known current state" : `Current-state focus unavailable: ${layer.current.reason || "current state unknown"}`;
      controls.focus.title = focusReason;
      normalStatus = layer.current.status === "known" ? `${layer.title}. Select a state to inspect it; this graph is read-only.` : `${focusReason}. ${layer.current.suppliedToken || ""}`;
      status.textContent = normalStatus;
      const initial = layer.current.status === "known" ? layer.current.nodeId : null;
      if (initial) selectNode(initial);
      else {
        details.textContent = `Current state unavailable: ${layer.current.reason || "unknown"}. ${layer.current.suppliedToken || ""} Select an authoritative state to inspect its details.`;
        world.querySelector("[data-node-id]")?.setAttribute("tabindex", "0");
      }
      fit();
      applyCamera();
      viewport.dataset.rendered = "true";
    } catch (error) { failure(error); }
  }

  if (!viewport || !details || !status || !zoomValue || Object.values(controls).some((control) => !control) || !Array.isArray(graph?.layers)) {
    failure(new Error("Graph data or controls unavailable"));
    return;
  }
  for (const button of layerButtons) {
    button.disabled = false;
    button.addEventListener("click", () => renderLayer(button.dataset.graphLayer));
  }
  controls["zoom-in"].addEventListener("click", () => zoom(0.25));
  controls["zoom-out"].addEventListener("click", () => zoom(-0.25));
  controls.fit.addEventListener("click", fit);
  controls.reset.addEventListener("click", () => {
    if (!world) return;
    const bounds = layer.geometry.bounds;
    pendingFit = false;
    center(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, 1);
  });
  controls.focus.addEventListener("click", () => focusNode(layer.current.nodeId, true));
  viewport.addEventListener("keydown", (event) => {
    if (event.target !== viewport || !world) return;
    const delta = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] }[event.key];
    if (delta) { event.preventDefault(); camera.x += delta[0]; camera.y += delta[1]; applyCamera(); }
  });
  viewport.addEventListener("pointerdown", (event) => {
    if (!world || event.button !== 0 || drag) return;
    suppressClick = false;
    if (event.target.closest("[data-node-id]")) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y, moved: false };
    try { viewport.setPointerCapture(event.pointerId); } catch { /* Synthetic or inactive pointers cannot be captured. */ }
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    event.preventDefault();
    camera.x = drag.cameraX + dx;
    camera.y = drag.cameraY + dy;
    applyCamera();
  });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  }
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);
  viewport.addEventListener("lostpointercapture", endDrag);
  viewport.addEventListener("click", (event) => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, true);

  function syncFullscreen() {
    const native = document.fullscreenElement === root;
    const active = expanded || native;
    root.classList.toggle("expanded-graph-view", expanded);
    controls.fullscreen.textContent = active ? expanded ? "Exit expanded graph view" : "Exit fullscreen" : "Open graph fullscreen";
    controls.fullscreen.setAttribute("aria-label", controls.fullscreen.textContent);
    controls.fullscreen.setAttribute("aria-expanded", String(active));
    if (!active && restoreFocus) {
      status.textContent = normalStatus;
      restoreFocus.focus({ preventScroll: true });
      restoreFocus = null;
    }
    if (pendingFit) fit();
  }
  async function exitFullscreen() {
    if (document.fullscreenElement === root) {
      try { await document.exitFullscreen(); } catch { status.textContent = "Fullscreen exit was rejected. Use the browser fullscreen exit control."; }
    }
    expanded = false;
    syncFullscreen();
  }
  controls.fullscreen.addEventListener("click", async () => {
    if (expanded || document.fullscreenElement === root) { await exitFullscreen(); return; }
    restoreFocus = controls.fullscreen;
    if (typeof root.requestFullscreen === "function") {
      try { await root.requestFullscreen(); syncFullscreen(); return; } catch { /* Expanded view remains available when native fullscreen is denied. */ }
    }
    expanded = true;
    status.textContent = "Expanded graph view (native fullscreen unavailable). Use Exit expanded graph view or Escape to return.";
    syncFullscreen();
    controls.fullscreen.focus();
  });
  document.addEventListener("fullscreenchange", syncFullscreen);
  document.addEventListener("keydown", (event) => {
    if (!expanded && document.fullscreenElement !== root) return;
    if (event.key === "Escape") { event.preventDefault(); void exitFullscreen(); }
    if (event.key === "Tab" && expanded) {
      const focusable = [...root.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"], summary')].filter((element) => element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  document.addEventListener("inspect-run-viewer:tabchange", (event) => { if (event.detail?.tabName === "graph" && pendingFit) fit(); });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (pendingFit) fit(); }).observe(viewport);
  if (graph.layers.some((entry) => entry.id === graph.initialLayerId)) renderLayer(graph.initialLayerId);
  else failure(new Error("Initial inspection layer unavailable"));
}

if (typeof document !== "undefined") {
  for (const root of document.querySelectorAll("[data-inspection-graph-root]")) {
    try {
      const data = root.querySelector("[data-inspection-graph-data]");
      mountInspectionGraph(root, JSON.parse(data.textContent));
    } catch {
      mountInspectionGraph(root, null);
    }
  }
}
