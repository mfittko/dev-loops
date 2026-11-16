### Changed
- An existing `gates.<gate>.angles[].tier` now applies on Claude review dispatch, and a concrete angle `model` now applies on Pi only (#3166)
- With `gates.requireFanoutProvenance`, the `distinctReviewers` floor drops to `max(1, units)` only for a corroborated size tier with `gates.fanout.sizeTiers` set, else `max(2, units)` (#3166)
