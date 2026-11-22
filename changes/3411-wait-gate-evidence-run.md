### Changed

- `merge-pr` waits up to 540 s for Gate evidence, then refuses a failed latest non-cancelled run without `gate-evidence` success, a timeout, or a head change after a wait or failed-run read (#3411)
