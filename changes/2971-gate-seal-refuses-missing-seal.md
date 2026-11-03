### Fixed

- A seal mismatch or a missing seal at a converted gate ledger or findings-log reader now fails closed with the typed code `gate_artifact_out_of_band_write` or `gate_artifact_unsealed`; `detect-checkpoint-evidence`, `waive-adr-tripwire` and the local judge-disposition lookup join the converted readers (#2971)
