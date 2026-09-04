# Playwright WebKit on GitHub Actions

The browser cache and WebKit's native Linux dependencies are separate layers. `PLAYWRIGHT_BROWSERS_PATH` relocates downloaded browser binaries, while `playwright install --with-deps webkit` also installs required system packages. Restoring the browser directory does not restore those packages ([Playwright browser docs](https://playwright.dev/docs/browsers#managing-browser-binaries), [Playwright CI docs](https://playwright.dev/docs/ci#caching-browsers)).

This distinction was reproduced on PR #1968: restoring the pinned WebKit build while skipping the install command made MiniBrowser exit 127 because a required font library was absent.

GitHub-hosted jobs use fresh VMs. The Ubuntu runner inventory does not promise Playwright WebKit or its complete native dependencies ([GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners), [Ubuntu 24.04 runner inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)). Therefore CI must install WebKit dependencies on every job or use an exact-version Playwright container that already includes them.

The supported repository default remains the browser-targeted command:

```sh
playwright install --with-deps webkit
```

Playwright does not recommend caching browser binaries in CI because restoring the archive is often comparable to downloading it and Linux dependencies still need installation. If the current cache is retained, it must never be used to skip native dependency installation ([Playwright CI guidance](https://playwright.dev/docs/ci#caching-browsers)). A one-package `libwoff1` workaround is intentionally avoided because the required dependency set varies with the Playwright/WebKit version.
