### Fixed

- Secret scan no longer flags repo file paths that end in a file extension or timestamped migration names as credentials; a random secret with `/` and no file extension is still flagged (#3054)
