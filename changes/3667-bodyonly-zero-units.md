### Fixed

- A PR-body-only posted round retires automatically only when a dispatch unit holds a body-reading angle; with none it keeps the refusal and the operator recovery; the gate-coordination detector applies the same check, reading the gate context from the checkout that wrote it, so `bodyOnlyRetire` stays false for zero body-reading units (#3667)
