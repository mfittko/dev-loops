### Fixed

- The retro tooling checker reads piped stdin to EOF, so a transcript over 64KB no longer reports clean, and empty or unreadable input exits 2 with a reason (#2646)
