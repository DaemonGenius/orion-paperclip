# Orion Task, Run, and REQ Ledger Contract v0

Orion keeps Paperclip tasks as the backing task table for the MVP, but public Orion contracts call them Tasks.

One Task can have many Runs. One Run has one DB-backed REQ Ledger.

The ledger records:

- lifecycle status and current phase
- plan hash and approved plan hash
- append-only events
- phase artifacts, with large files linked through asset storage
- verification status
- PR receipt when Orion opens or records a PR

Plan hash binding is mandatory once a plan is approved. PR receipts and post-approval execution evidence must reference the approved plan hash when one exists.
