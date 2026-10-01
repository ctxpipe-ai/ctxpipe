# Consolidate intent and ADRs

Status: needs-triage
Priority: P1
Owner: unassigned
Blocked by: none
Created: 2026-10-01
Updated: 2026-10-01

## Context

The user confirmed the branch's ADRs are not accurate. ADR-045–048 (recovery CI, revision identity, durable writes, sandbox ownership) are long, partly contradictory (e.g. ADR-048 says the Docker chat journey is open while Gate 4 was closed), and describe patch-based designs that tickets 01–03 are removing. The wayfinder map and issues under `../git-backed-projects/` hold the locked product intent; PRDs live in `.ai/memory/PRDs/`.

## Goal

A short, accurate description of what ships: product intent (map + PRDs), and ADRs that each state one decision the code actually implements.

## Plan (sketch — expand before review)

1. Inventory every claim in ADR-040–048 and the map's "locked" bullets; mark true / false / superseded against the code.
2. Rewrite as fewer, shorter ADRs (supersede rather than edit history where a decision changed), using `capture-adr`.
3. Update the decisions index, glossary, lessons-learned, and root/app `AGENTS.md` pointers.
4. Re-run after tickets 01–03 land, since they change sandbox/chat decisions.

## Comments

## Resolution
