import assert from "node:assert/strict";
import { test } from "bun:test";
import { layoutInspectionLayer } from "../../scripts/loop/inspect-run-viewer/graph-layout.mjs";
import { OUTER_TRANSITIONS } from "@dev-loops/core/loop/conductor-routing";
import { TRANSITIONS as COPILOT_TRANSITIONS } from "@dev-loops/core/loop/copilot-loop-state";
import { REVIEWER_TRANSITIONS } from "@dev-loops/core/loop/reviewer-loop-state";
import { LIFECYCLE_TRANSITIONS } from "@dev-loops/core/loop/lifecycle-state";

function topology(states, pairs = []) {
  return {
    nodes: states.map((stateId) => ({ id: `state:${stateId}`, stateId, label: stateId })),
    edges: pairs.map(([from, to]) => ({ id: `edge:${from}:${to}`, from: `state:${from}`, to: `state:${to}` })),
    cues: [],
    cueLinks: [],
  };
}

function boundary(point, node) {
  const epsilon = 0.000001;
  const insideX = point.x >= node.x - epsilon && point.x <= node.x + node.width + epsilon;
  const insideY = point.y >= node.y - epsilon && point.y <= node.y + node.height + epsilon;
  return insideX && insideY && (
    Math.abs(point.x - node.x) < epsilon || Math.abs(point.x - node.x - node.width) < epsilon ||
    Math.abs(point.y - node.y) < epsilon || Math.abs(point.y - node.y - node.height) < epsilon
  );
}

function assertCompleteGeometry(input, geometry) {
  assert.equal(geometry.status, "available");
  const vertices = [...input.nodes, ...input.cues];
  const links = [...input.edges, ...input.cueLinks];
  assert.deepEqual(new Set(geometry.nodes.map(({ id }) => id)), new Set(vertices.map(({ id }) => id)));
  assert.deepEqual(new Set(geometry.edges.map(({ id }) => id)), new Set(links.map(({ id }) => id)));
  const byId = new Map(geometry.nodes.map((node) => [node.id, node]));
  const { x, y, width, height } = geometry.bounds;
  for (const value of [x, y, width, height]) assert.ok(Number.isFinite(value));
  assert.ok(width > 0 && height > 0);
  function contained(point) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x >= x + 15.999999 && point.x <= x + width - 15.999999);
    assert.ok(point.y >= y + 15.999999 && point.y <= y + height - 15.999999);
  }
  for (const node of geometry.nodes) {
    assert.ok(Number.isFinite(node.width) && node.width > 0);
    assert.ok(Number.isFinite(node.height) && node.height > 0);
    contained(node);
    contained({ x: node.x + node.width, y: node.y + node.height });
  }
  for (let i = 0; i < geometry.nodes.length; i += 1) {
    for (const other of geometry.nodes.slice(i + 1)) {
      const node = geometry.nodes[i];
      assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x ||
        node.y + node.height <= other.y || other.y + other.height <= node.y,
      `overlapping cards: ${node.id}, ${other.id}`);
    }
  }
  const routes = new Map(geometry.edges.map((edge) => [edge.id, edge.points]));
  for (const edge of links) {
    const points = routes.get(edge.id);
    assert.ok(points.length >= 2);
    for (const point of points) contained(point);
    assert.ok(new Set(points.map(({ x, y }) => `${x},${y}`)).size >= 2);
    assert.ok(boundary(points[0], byId.get(edge.from)), `source attachment: ${edge.id}`);
    assert.ok(boundary(points.at(-1), byId.get(edge.to)), `target attachment: ${edge.id}`);
    if (edge.from === edge.to) {
      const node = byId.get(edge.from);
      assert.ok(points.some((point) => point.x < node.x || point.x > node.x + node.width ||
        point.y < node.y || point.y > node.y + node.height), `external self-loop: ${edge.id}`);
    }
  }
}

test("directed layout preserves cycles, reciprocal feedback, self-loops and disconnected cards", () => {
  const input = topology(["a", "b", "c", "isolated"], [["a", "b"], ["b", "a"], ["b", "c"], ["c", "a"], ["b", "b"]]);
  const geometry = layoutInspectionLayer(input);
  assertCompleteGeometry(input, geometry);
  const forward = geometry.edges.find(({ id }) => id === "edge:a:b").points;
  const reverse = geometry.edges.find(({ id }) => id === "edge:b:a").points;
  assert.notDeepEqual(forward, reverse.toReversed());
});

test("acyclic transitions progress left to right while cue routes stay separate and complete", () => {
  const input = topology(["start", "middle", "end"], [["start", "middle"], ["middle", "end"]]);
  input.cues = [{ id: "entry", kind: "entry", label: "Start" }, { id: "exit", kind: "exit", label: "End" }];
  input.cueLinks = [{ id: "enter", kind: "entry", from: "entry", to: "state:start" }, { id: "leave", kind: "exit", from: "state:end", to: "exit" }];
  const geometry = layoutInspectionLayer(input);
  assertCompleteGeometry(input, geometry);
  const byId = new Map(geometry.nodes.map((node) => [node.id, node]));
  for (const edge of [...input.edges, ...input.cueLinks]) {
    assert.ok(byId.get(edge.from).x + byId.get(edge.from).width < byId.get(edge.to).x);
  }
  assert.deepEqual(byId.get("entry").stateIdLines, []);
});

test("long labels and identifiers wrap losslessly, grow cards, and preserve Unicode characters", () => {
  const input = topology(["short", `phase_${"😀".repeat(90)}_complete`], [["short", `phase_${"😀".repeat(90)}_complete`]]);
  input.nodes[1].label = "A complete label with whitespace_and_underscore wrapping " + "長".repeat(100);
  const geometry = layoutInspectionLayer(input);
  assertCompleteGeometry(input, geometry);
  const byId = new Map(geometry.nodes.map((node) => [node.id, node]));
  for (const node of input.nodes) {
    const result = byId.get(node.id);
    assert.equal(result.labelLines.join(""), node.label);
    assert.equal(result.stateIdLines.join(""), node.stateId);
    for (const line of [...result.labelLines, ...result.stateIdLines]) assert.ok(Array.from(line).length <= 30);
  }
  assert.ok(byId.get(input.nodes[1].id).height > byId.get(input.nodes[0].id).height);
});

test("geometry is deterministic under input reordering and all snapshot-only emphasis changes", () => {
  const input = topology(["c", "a", "b"], [["c", "a"], ["a", "b"], ["b", "c"], ["a", "a"]]);
  const original = structuredClone(input);
  const expected = layoutInspectionLayer(input);
  assert.deepEqual(input, original, "layout must not mutate the semantic model");
  for (const emphasis of ["current", "next", "terminal", "inactive"]) {
    const changed = {
      ...input,
      nodes: input.nodes.toReversed().map((node) => ({ ...node, terminal: true, snapshot: { current: true, next: true, emphasis } })),
      edges: input.edges.toReversed(),
    };
    assert.deepEqual(layoutInspectionLayer(changed), expected);
  }
});

for (const [name, transitions] of Object.entries({ outer: OUTER_TRANSITIONS, copilot: COPILOT_TRANSITIONS, reviewer: REVIEWER_TRANSITIONS, lifecycle: LIFECYCLE_TRANSITIONS })) {
  test(`${name} authoritative topology has complete non-overlapping cards and directed bounded routes`, () => {
    const input = topology(Object.keys(transitions), Object.entries(transitions).flatMap(([from, targets]) => targets.map((to) => [from, to])));
    assertCompleteGeometry(input, layoutInspectionLayer(input));
  });
}

test("dense graphs retain every directed pair and self-loop without geometry truncation", () => {
  const states = Array.from({ length: 12 }, (_, index) => `dense_${index}`);
  const input = topology(states, states.flatMap((from) => states.map((to) => [from, to])));
  assertCompleteGeometry(input, layoutInspectionLayer(input));
});

const invalidCases = [
  ["missing list", (input) => { delete input.cueLinks; }],
  ["duplicate state identity", (input) => { input.nodes.push({ ...input.nodes[0] }); }],
  ["duplicate cue/state identity", (input) => { input.cues.push({ id: "state:a", kind: "entry", label: "Start" }); }],
  ["missing state identity", (input) => { input.nodes[0].id = ""; }],
  ["invalid label", (input) => { input.nodes[0].label = null; }],
  ["duplicate edge identity", (input) => { input.edges.push({ id: input.edges[0].id, from: "state:b", to: "state:a" }); }],
  ["duplicate ordered pair", (input) => { input.edges.push({ ...input.edges[0], id: "another" }); }],
  ["unknown source", (input) => { input.edges[0].from = "missing"; }],
  ["unknown target", (input) => { input.edges[0].to = "missing"; }],
  ["unknown cue endpoint", (input) => { input.cueLinks.push({ id: "enter", kind: "entry", from: "missing", to: "state:a" }); }],
  ["transition to presentation cue", (input) => { input.cues.push({ id: "exit", kind: "exit", label: "End" }); input.edges[0].to = "exit"; }],
  ["reversed entry association", (input) => { input.cues.push({ id: "entry", kind: "entry", label: "Start" }); input.cueLinks.push({ id: "enter", kind: "entry", from: "state:a", to: "entry" }); }],
];
for (const [name, change] of invalidCases) {
  test(`invalid topology rejects ${name} instead of inserting or dropping elements`, () => {
    const input = topology(["a", "b"], [["a", "b"]]);
    change(input);
    assert.throws(() => layoutInspectionLayer(input), (error) => error.code === "invalid_graph");
  });
}
