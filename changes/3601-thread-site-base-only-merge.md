### Fixed

- A base-only merge between a delta-verified fixer commit and the live head no longer refuses `thread_site_unverifiable`, and the refusals that remain name the draft-PR recovery (`gate close-sequence`, then the next `draft_gate` round) (#3601)
