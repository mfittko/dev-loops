---
name: "final-approval"
description: "Internal routed strategy behind `dev-loop` for the final human approval and merge gate. The canonical procedure now lives in copilot-pr-followup."
allowed-tools: Read Bash Edit Write Agent
user-invocable: false
---
<!-- GENERATED from skills/final-approval/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# Final Approval (redirect)

This route now uses [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) as the canonical procedure owner.

When the public router selects `final_approval`, load [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md)
and follow its **Human approval checkpoint** section inside Step 7.

Use this redirect only as a narrowed read-set pointer for the routed `final_approval` strategy.
Do not restate merge-ready preconditions, gate evidence rules, or merge authorization policy here.
