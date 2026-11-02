// CLI-CHECKOUT-DELEGATION refusal: the installed CLI exits 1 instead of running stale code when the checkout CLI does not start.
export function checkoutDelegationRefusal({ installed, checkoutVersion, root, code, argvText }) {
  return `cli_version_skew: installed ${installed}, checkout ${checkoutVersion}; the checkout CLI did not start (${code}). CLI-CHECKOUT-DELEGATION refused to continue. Rerun: dev-loops-run --repo-root ${root} cli/index.mjs ${argvText}`;
}
