### Added
- An opt-in `gates.fanout.sizeTiers` setting packs more review angles per reviewer unit for small changes, and Claude review angles can follow their own model tier (#3166)

### Changed
- An existing `gates.<gate>.angles[].tier` now applies on Claude review dispatch, and a concrete angle `model` now applies on Pi only (#3166)
