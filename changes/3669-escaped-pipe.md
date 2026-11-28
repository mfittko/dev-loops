### Fixed

- An AC/DoD matrix cell can contain a literal pipe written with a backslash before it: the matrix parser splits cells only at unescaped pipes and keeps the pipe in the cell text (#3669)
