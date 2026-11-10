# Visible errors and conversation ownership implementation plan

> **For agentic workers:** Use executing-plans for each owned task; do not overwrite other workers.

**Goal:** Persist visible errors for CLI diagnosis and repair verified new conversation binding.

**Architecture:** Extend existing storage diagnostics, share a small error reporter across isolated extension contexts, and read the same persisted state through a dependency-free CLI. Preallocated conversation IDs require server metadata verification before binding.

**Tech Stack:** MV3 JavaScript, Node tests, Python CLI, Edge isolated validation.

**Spec:** 设计对齐稿/错误日志与会话绑定修复.md

## Global Constraints

- Preserve settings, prompt, existing dialogs, library, fixed extension ID and temporary-chat privacy.
- Do not log authentication state, prompt, transcript or media; do not bind from URL alone.
- Keep external ongoing Whisper task isolated; integrate only committed/validated increments.

## Tasks

- [x] CLI worker: test and implement WAL/SST/Snappy selected-key reader, corruption warnings and private-data exclusion.
- [x] Journal worker: test and implement durable visible errors, redaction, runtime receiver and fallback.
- [x] Coordinator: reproduce preallocated-ID failure and implement server ownership proof with bounded reads; preserve rejection of old chats and failed sends.
- [x] Coordinator: wire every visible error entry point, package assets and dynamic reinjection; distinguish submit/library/title states.
- [x] Coordinator: run affected and project regressions, inspect state transitions, use isolated browser to verify message/storage/ownership behavior.
- [ ] Coordinator: refresh parallel implementation and installation, protect actual state, integrate/push task increments and verify final deliverable; record any actual blocker.
