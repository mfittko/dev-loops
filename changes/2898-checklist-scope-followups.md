### Changed
- The checkbox-row grammar lives in one core constant shared by the tick, the live preview and the edit-pr untick guard (#2898)
- The edit-pr untick guard and its usage text now name a heading edit that moves a checked row out of its AC/DoD scope (#2898)
- The unified row grammar also accepts a row ending in U+2028 or U+2029 on the tick side, so the tick now flips such a row when its label is reviewer-verified (#2898)
- The reviewer-verified tick docs describe the dry run before composing and the write before the post (#2898)
