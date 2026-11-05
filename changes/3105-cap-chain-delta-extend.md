### Changed

- `gate extend-cap-round-chain` extends the cap-round chain over code commits when a sealed `locally_clear` pre-push delta covers exactly chain end..head (`extension: "delta_covered"`), refuses `delta_range_mismatch` otherwise, and coordination routes a past-cap code commit to the command instead of a dead end (#3049, #3105)
