# (Qollab Edition)

![Video Game Cover](https://pub.qollab.xyz/assets/01a129db-1105-7d9e-82e9-c48d4a259302)

An interactive rock-paper-scissors strategy game built with Qiskit and designed for Qollab's **JS / Qiskit wrapper** project shape. Players make choices relative to a randomly selected pact (cooperate, betray, or neutral); a two-qubit circuit samples Q-Bot's move. Q-Bot's hidden personality is indifferent, reciprocal, or resentful, and updates its policy from the player's decisions.

## Execution modes

- **FULL MATCH / ONE QUANTUM JOB** (default): choose one move for each of the 15 randomly chosen agreements. The player choices are recorded first, then all 15 circuits are submitted together in a single `backend.run` call. This respects Qollab's limit of one job per project run for IonQ remote simulators. The strategy distribution for each round is calculated in sequence from the player's recorded decisions; this is valid for this model because Q-Bot's policy update depends on the player's action category, not on the result of the rock-paper-scissors comparison.
- **ROUND BY ROUND / LOCAL SIMULATORS**: Q-Bot is measured and revealed after each choice. Use a local simulator (built-in, AWS Braket or IBM noise-model simulator). Do not use this mode with IonQ remote backends because they only accept one job per project run.

The camera, MediaPipe `hand_landmarker.task`, the separately trained five-angle VQC, and the localhost streaming bridge **_are intentionally not included in this Qollab version_**. Qollab runs inside a browser sandbox; this adaptation is manual-input only and keeps the local webcam/VQC version separate.

## Circuit and decisions

For each round, the current policy gives probabilities for cooperation, betrayal and neutral. Those are mapped to the actual symbols relative to the random agreement, then prepared by the two-qubit state-preparation circuit:

- `|00>` → rock
- `|01>` → paper
- `|10>` → scissors
- `|11>` has zero ideal amplitude. If a noisy backend returns `|11>`, the UI reports it and uses the highest-probability valid symbol as a transparent fallback.

The Python helper does not instantiate `AerSimulator`; it receives Qollab's injected `backend` and calls it through `.callPromising(...)` from `main.js`.

## Scoring

- Both cooperate: +3 points each.
- Both betray: +1 point each.
- If at least one player betrays and there is a rock-paper-scissors winner: +5 to the winner, 0 to the other player.
- Other outcomes: 0 points.
- Correctly guessing Q-Bot's personality after 15 rounds earns +15 bonus points.

## Attribution and disclosure

The game mechanics and quantum state-preparation approach are adapted from code supplied by the project team. The camera-based MediaPipe and trained VQC recognition system belong to the team's separate local version. The Qollab adaptation, UI integration, batch execution mode, and explanatory circuit panel are part of the hackathon project work.
