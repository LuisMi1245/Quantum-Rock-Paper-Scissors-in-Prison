"""Quantum Arcade's Qollab-compatible quantum decision engine.

This module deliberately does not instantiate AerSimulator. Qollab injects the
selected `backend`; pass it to run_quantum_batch so the same circuit can execute
on a local simulator or an IonQ simulator.

The JSON input is a list of [P(rock), P(paper), P(scissors)] rows. A single
backend.run call measures one circuit per row. In IonQ-compatible batch mode,
all 15 rounds are submitted as one job, respecting Qollab's one-job-per-run rule.
"""
from __future__ import annotations

import json
import math
from typing import Any

from qiskit import QuantumCircuit


def build_decision_circuit(p_rock: float, p_paper: float, p_scissors: float):
    """Prepare sqrt(p00)|00> + sqrt(p01)|01> + sqrt(p10)|10> and measure.

    Qiskit count strings are displayed as c1c0. With measure([0,1],[0,1]),
    00 -> rock, 01 -> paper, and 10 -> scissors. The ideal amplitude of 11 is 0.
    """
    values = [float(p_rock), float(p_paper), float(p_scissors)]
    if any((not math.isfinite(value)) or value < 0 for value in values):
        raise ValueError("The three symbol probabilities must be finite and non-negative.")
    total = sum(values)
    if total <= 1e-12:
        raise ValueError("The symbol probability distribution must have positive sum.")
    p00, p01, p10 = (value / total for value in values)

    circuit = QuantumCircuit(2, 2)
    theta = 2 * math.asin(math.sqrt(max(0.0, min(1.0, p10))))
    circuit.ry(theta, 1)

    if p00 + p01 > 1e-12:
        phi = 2 * math.atan2(math.sqrt(p01), math.sqrt(p00))
        circuit.x(1)
        circuit.ry(phi / 2, 0)
        circuit.cx(1, 0)
        circuit.ry(-phi / 2, 0)
        circuit.cx(1, 0)
        circuit.x(1)
    else:
        phi = 0.0

    circuit.measure([0, 1], [0, 1])
    return circuit, theta, phi


def run_quantum_batch(backend: Any, probability_rows_json: str) -> str:
    """Run one or more rounds in exactly one selected-backend job.

    `backend` is provided by Qollab. This function must be called from a JS
    project using `.callPromising(...)`, particularly for IonQ backends.
    Return a JSON string to make the result easy to consume from JavaScript.
    """
    probability_rows = json.loads(str(probability_rows_json))
    if not isinstance(probability_rows, list) or not probability_rows:
        raise ValueError("Expected a non-empty list of probability rows.")

    circuits = []
    metadata = []
    for index, row in enumerate(probability_rows):
        if not isinstance(row, (list, tuple)) or len(row) != 3:
            raise ValueError(f"Probability row {index + 1} must contain [rock, paper, scissors].")
        circuit, theta, phi = build_decision_circuit(*row)
        circuits.append(circuit)
        metadata.append({
            "theta": float(theta),
            "phi": float(phi),
            "operations": int(circuit.size()),
            "probabilities": [float(value) for value in row],
        })

    # IonQ permits one job per project run; submit all circuits together when
    # batch mode is selected. A single round is also valid as a single circuit.
    submitted_circuits = circuits[0] if len(circuits) == 1 else circuits
    job = backend.run(submitted_circuits, shots=1)
    result = job.result()

    observations = []
    for index, circuit_metadata in enumerate(metadata):
        counts = result.get_counts(index)
        if not counts:
            raise RuntimeError(f"No measurement counts were returned for circuit {index + 1}.")
        raw_state = max(counts, key=counts.get).replace(" ", "")
        observations.append({**circuit_metadata, "state": raw_state})

    return json.dumps(observations, separators=(",", ":"))


__all__ = ["build_decision_circuit", "run_quantum_batch"]
