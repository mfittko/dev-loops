### Changed

- GitHub Pages Simulator navigation now opens the lifecycle Overview entrypoint (#2624)
- Paired links show Overview before Detailed, preserving both original pages' stable URLs and active-view labels (#2624)
- Simulator-family navigation aligns with each view's overall content container and keeps a clear desktop/mobile gap above paired-view controls (#2624)
- Simulator navigation changes preserve unrelated navigation and fullscreen graph layout (#2624)
- Detailed graphs expose a named keyboard-scrollable region; arrow panning does not change execution (#2624)
- Simulator pages improve light/dark contrast with state cues, expose graph controls to keyboard/screen-reader users, and add labeled keyboard-scrollable traces and a main landmark (#2624)
- Simulator desktop/mobile UI checks use controlled local fallback fonts instead of live Google Fonts, keeping layout checks and captures independent of external font availability (#2624)
- Original Detailed and Overview models load from separate native modules; teaching scenarios, defaults, transitions, and runtime controls are preserved (#2624)
- Original model asset changes select their owning automatic browser suite; published pages and npm packages include both modules (#2624)
- Overview transitions reuse model-scoped helpers with explicit run state instead of recreating five helper functions per step (#2624)
