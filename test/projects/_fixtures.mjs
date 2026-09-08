// Shared plain-data Projects GraphQL fixtures for the test/projects suites.
//
// Only response literals that are byte-identical across two or more suites live
// here. Callers whose GraphQL shape genuinely differs — a realistic node id, a
// projection that omits pageInfo, a distinct project number/url, an org branch —
// keep their own explicit literal so the per-command projection differences
// (owned by the shared Projects discovery/cursor code) stay visible at the call
// site. This is plain data plus two tiny id-parameterized builders, not a
// fixture DSL: option/name/id variations are passed explicitly by the caller.

export function userPayload() {
  return { data: { user: { id: "U_kgDOABC123" } } };
}

export function noUserPayload() {
  return { data: { user: null } };
}

export function orgPayload() {
  return { data: { organization: { id: "O_kgDOXYZ789" } } };
}

// The queue Status single-select field. The option set is fixed across suites;
// only the field node id varies (opaque placeholder vs a realistic GraphQL id),
// so it is the one explicit parameter.
export function statusField(id = "PVTSSF_status") {
  return {
    id,
    name: "Status",
    options: [
      { id: "opt1", name: "Backlog" },
      { id: "opt2", name: "Next Up" },
      { id: "opt3", name: "In Progress" },
      { id: "opt4", name: "Done" },
    ],
  };
}

// The discovered queue project. number/title/url are fixed across the suites
// that share this shape; only the node id varies, so it is the one parameter.
export function existingProject(id = "PVT_proj1") {
  return {
    id,
    number: 1,
    title: "Dev Loop Queue",
    url: "https://github.com/users/mfittko/projects/1",
  };
}

// The single-page fields query envelope. Suites whose projection differs (for
// example one that omits pageInfo) keep their own local shape instead.
export function fieldsResponse(fields) {
  return { data: { node: { fields: { nodes: fields, pageInfo: { hasNextPage: false } } } } };
}

// The single-page items-by-content query envelope.
export function itemsByContentResponse(items) {
  return { data: { node: { items: { nodes: items, pageInfo: { hasNextPage: false, endCursor: null } } } } };
}
