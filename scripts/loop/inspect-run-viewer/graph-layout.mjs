import dagre from "@dagrejs/dagre";

const ARROW_PADDING = 16;
const BOUNDARY_EPSILON = 0.000001;
const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

// Keep separators as well as Unicode code points: wrapping must not discard text.
function wrapText(text, budget) {
  const characters = Array.from(text);
  const lines = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + budget, characters.length);
    if (end < characters.length) {
      for (let index = end - 1; index >= start; index -= 1) {
        if (/\s|_/.test(characters[index])) {
          end = index + 1;
          break;
        }
      }
    }
    lines.push(characters.slice(start, end).join(""));
    start = end;
  }
  return lines.length ? lines : [""];
}

function validateTopology(topology) {
  if (!topology || !["nodes", "edges", "cues", "cueLinks"].every((key) => Array.isArray(topology[key]))) {
    fail("invalid_graph", "Inspection layout requires nodes, edges, cues and cueLinks arrays.");
  }
  const identities = new Set();
  function identity(item) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || identities.has(item.id)) {
      fail("invalid_graph", "Inspection graph identities must be nonempty and unique.");
    }
    identities.add(item.id);
  }
  const states = new Set();
  const cues = new Map();
  for (const node of topology.nodes) {
    identity(node);
    if (typeof node.stateId !== "string" || !node.stateId.trim() || typeof node.label !== "string") {
      fail("invalid_graph", `Invalid state text for ${node.id}.`);
    }
    states.add(node.id);
  }
  for (const cue of topology.cues) {
    identity(cue);
    if (!["entry", "exit"].includes(cue.kind) || typeof cue.label !== "string") {
      fail("invalid_graph", `Invalid presentation cue ${cue.id}.`);
    }
    cues.set(cue.id, cue.kind);
  }
  const pairs = new Map();
  function edgeIdentity(edge) {
    identity(edge);
    if (typeof edge.from !== "string" || typeof edge.to !== "string") {
      fail("invalid_graph", `Invalid endpoints for ${edge.id}.`);
    }
    let targets = pairs.get(edge.from);
    if (!targets) {
      targets = new Set();
      pairs.set(edge.from, targets);
    }
    if (targets.has(edge.to)) fail("invalid_graph", `Duplicate directed pair for ${edge.id}.`);
    targets.add(edge.to);
  }
  for (const edge of topology.edges) {
    edgeIdentity(edge);
    if (!states.has(edge.from) || !states.has(edge.to)) {
      fail("invalid_graph", `Unknown executable endpoint for ${edge.id}.`);
    }
  }
  for (const link of topology.cueLinks) {
    edgeIdentity(link);
    const validEntry = link.kind === "entry" && cues.get(link.from) === "entry" && states.has(link.to);
    const validExit = link.kind === "exit" && states.has(link.from) && cues.get(link.to) === "exit";
    if (!validEntry && !validExit) fail("invalid_graph", `Invalid cue association ${link.id}.`);
  }
}

function onBoundary(point, node) {
  return point.x >= node.x - BOUNDARY_EPSILON && point.x <= node.x + node.width + BOUNDARY_EPSILON &&
    point.y >= node.y - BOUNDARY_EPSILON && point.y <= node.y + node.height + BOUNDARY_EPSILON && (
      Math.abs(point.x - node.x) <= BOUNDARY_EPSILON ||
      Math.abs(point.x - node.x - node.width) <= BOUNDARY_EPSILON ||
      Math.abs(point.y - node.y) <= BOUNDARY_EPSILON ||
      Math.abs(point.y - node.y - node.height) <= BOUNDARY_EPSILON
    );
}

/** Server-only layout of authoritative topology; snapshot flags never affect geometry. */
export function layoutInspectionLayer(topology) {
  validateTopology(topology);
  try {
    const vertices = [
      ...topology.nodes.map((node) => {
        const labelLines = wrapText(node.label, 30);
        const stateIdLines = wrapText(node.stateId, 30);
        // 16px padding, 20/16px text rows, two 8px gaps and a fixed 28px badge row.
        return { id: node.id, width: 320, height: 76 + 20 * labelLines.length + 16 * stateIdLines.length, labelLines, stateIdLines };
      }),
      ...topology.cues.map((cue) => {
        const labelLines = wrapText(cue.label, 16);
        return { id: cue.id, width: 160, height: 32 + 20 * labelLines.length, labelLines, stateIdLines: [] };
      }),
    ].sort(compareIds);
    const links = [...topology.edges, ...topology.cueLinks].sort(compareIds);
    const graph = new dagre.graphlib.Graph({ directed: true, multigraph: true });
    graph.setGraph({
      rankdir: "LR", ranker: "network-simplex", acyclicer: "greedy",
      nodesep: 48, edgesep: 24, ranksep: 96, marginx: 32, marginy: 32,
    });
    for (const vertex of vertices) graph.setNode(vertex.id, { width: vertex.width, height: vertex.height });
    // All endpoints have been validated before Dagre can implicitly create any nodes.
    for (const link of links) graph.setEdge(link.from, link.to, {}, link.id);
    dagre.layout(graph);
    if (graph.nodeCount() !== vertices.length || graph.edgeCount() !== links.length) {
      fail("layout_failed", "Layout changed inspection topology membership.");
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    function includePoint(point) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        fail("layout_failed", "Layout returned nonfinite geometry.");
      }
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const nodes = vertices.map((vertex) => {
      const position = graph.node(vertex.id);
      if (!position || position.width !== vertex.width || position.height !== vertex.height ||
        !Number.isFinite(vertex.width) || !Number.isFinite(vertex.height) || vertex.width <= 0 || vertex.height <= 0) {
        fail("layout_failed", `Layout returned invalid dimensions for ${vertex.id}.`);
      }
      const node = { ...vertex, x: position.x - vertex.width / 2, y: position.y - vertex.height / 2 };
      includePoint(node);
      includePoint({ x: node.x + node.width, y: node.y + node.height });
      return node;
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = links.map((link) => {
      const route = graph.edge({ v: link.from, w: link.to, name: link.id });
      if (!route || !Array.isArray(route.points) || route.points.length < 2) {
        fail("layout_failed", `Layout omitted route ${link.id}.`);
      }
      const points = route.points.map((point) => {
        includePoint(point);
        return { x: point.x, y: point.y };
      });
      if (!points.some((point) => point.x !== points[0].x || point.y !== points[0].y) ||
        !onBoundary(points[0], byId.get(link.from)) || !onBoundary(points.at(-1), byId.get(link.to))) {
        fail("layout_failed", `Layout returned invalid directed attachments for ${link.id}.`);
      }
      return { id: link.id, points };
    });
    if (!nodes.length) minX = minY = maxX = maxY = 0;
    const bounds = {
      x: minX - ARROW_PADDING, y: minY - ARROW_PADDING,
      width: maxX - minX + 2 * ARROW_PADDING, height: maxY - minY + 2 * ARROW_PADDING,
    };
    if (!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
      fail("layout_failed", "Layout returned invalid graph bounds.");
    }
    return { status: "available", bounds, nodes, edges };
  } catch (error) {
    if (error.code === "layout_failed") throw error;
    fail("layout_failed", "Inspection graph layout failed.", error);
  }
}
