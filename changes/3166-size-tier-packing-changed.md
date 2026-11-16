### Changed
- An existing `gates.<gate>.angles[].tier` now applies on Claude review dispatch, and a concrete angle `model` now applies on Pi only (#3166)
- With `gates.requireFanoutProvenance`, the `distinctReviewers` floor drops to `max(1, fresh dispatch units)` only for a corroborated applied size tier in a repo that sets `gates.fanout.sizeTiers`, else it stays `max(2, fresh dispatch units)` (#3166)
