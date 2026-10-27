### Fixed

- `gate judge-pass` expands a cluster-keyed spec-authority decision to every member finding, so two angles reporting one defect no longer refuse with "does not dispose 1 finding(s)"; a differing member decision refuses with `spec_authority_cluster_conflict` (#2903)
