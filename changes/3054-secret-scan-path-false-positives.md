### Fixed

- The secret-scan high-entropy detector no longer flags repo-relative file paths or timestamped migration file names as credentials; a random secret that contains `/` is still flagged (#3054)
