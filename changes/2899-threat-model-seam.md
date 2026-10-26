### Fixed

- Run the threat-model angle on a SECURITY_SENSITIVE_SEAM diff in a draft gate round, or in a pre_approval gate round at a head where no draft gate round ran threat-model, despite `enabled: false`, and record config-disabled angles as dropped (#2899)
