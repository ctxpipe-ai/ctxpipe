# Gate 2 — revision and projection ownership

Status: IN PROGRESS.
Fixed starting checkpoint: `d87858354a783a9fd95c46785208c9b699a45e3b`, independently approved and verified remotely after all 13 Gate 1 CI jobs passed.

Gate 1 terminal evidence is recorded alongside this starting checkpoint. Gate 2 implementation follows the requirements in `../workspace-chat-recovery.md`: immutable revision policy, one native Git acquisition path, pure parsing, atomic generation/SHA activation, and independent derived-store freshness. Required contracts cover no-op, rewind, relink races, malformed files, deletion, 100-file budget, derived failures and atomic visibility.
