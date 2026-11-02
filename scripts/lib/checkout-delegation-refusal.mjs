// POSIX single-quote an argument so a pasted hint reproduces the exact bytes.
export const shellQuote = (arg) => (/^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);

// CLI-CHECKOUT-DELEGATION refusal: the installed CLI exits 1 instead of running stale code when the checkout CLI does not start.
export function checkoutDelegationRefusal({ installed, checkoutVersion, root, code, argv }) {
  return `cli_version_skew: installed ${installed}, checkout ${checkoutVersion}; the checkout CLI did not start (${code}). CLI-CHECKOUT-DELEGATION refused to continue. Rerun: dev-loops-run --repo-root ${shellQuote(root)} cli/index.mjs ${argv.map(shellQuote).join(" ")}`;
}
