### Fixed

- wait-pr-checks backs off and retries on a secondary rate limit, reads the head over REST when GraphQL is limited, and names the RATE_LIMITED budget (#3263)
