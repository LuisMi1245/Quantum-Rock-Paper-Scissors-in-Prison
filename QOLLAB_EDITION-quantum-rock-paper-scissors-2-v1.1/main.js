// This JS code can't be run outside of Qollab environment (needs Pyodide and other components
// for proper Qiskit integration into JS code). If any Qiskit features / packages are used, it
// fill fail as soon as those are imported (or "backend" variable is used)

import * as quantumEngine from 'quantum_prisoners_dilemma';

const TOTAL_ROUNDS = 15;
const SYMBOLS = ['piedra', 'papel', 'tijeras'];
const UI_MOVES = {
  rock: { symbol: 'piedra', label: 'ROCK', emoji: '✊' },
  paper: { symbol: 'papel', label: 'PAPER', emoji: '✋' },
  scissors: { symbol: 'tijeras', label: 'SCISSORS', emoji: '✌' }
};
const SYMBOL_META = {
  piedra: { label: 'ROCK', emoji: '✊', move: 'rock' },
  papel: { label: 'PAPER', emoji: '✋', move: 'paper' },
  tijeras: { label: 'SCISSORS', emoji: '✌', move: 'scissors' }
};
const PERSONALITIES = ['indiferente', 'reciproco', 'rencoroso'];
const PERSONALITY_LABELS = {
  indiferente: 'INDIFFERENT',
  reciproco: 'RECIPROCAL',
  rencoroso: 'RESENTFUL'
};
const BEATS = { piedra: 'papel', papel: 'tijeras', tijeras: 'piedra' };
const LOSES_TO = { piedra: 'tijeras', papel: 'piedra', tijeras: 'papel' };
const $ = id => document.getElementById(id);

let mode = 'batch';
let agreements = [];
let plans = [];
let history = [];
let roundIndex = 0;
let playerScore = 0;
let machineScore = 0;
let personality = null;
let policy = { pc: 1 / 3, pt: 1 / 3, pn: 1 / 3 };
let busy = false;
let gameFinished = false;
let guessSubmitted = false;
let audioContext = null;

function randChoice(items) { return items[Math.floor(Math.random() * items.length)]; }
function clonePolicy(value) { return { pc: value.pc, pt: value.pt, pn: value.pn }; }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
  $(id)?.classList.add('active');
  window.scrollTo(0, 0);
}
function setNotice(message, kind = '') {
  const node = $('notice');
  if (!node) return;
  node.textContent = message;
  node.className = `notice ${kind}`.trim();
}
function unlockAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
}
function playRoundSound() {
  unlockAudio();
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(740, now);
  oscillator.frequency.exponentialRampToValueAtTime(520, now + 0.085);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.03, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
  oscillator.connect(gain); gain.connect(audioContext.destination);
  oscillator.start(now); oscillator.stop(now + 0.12);
}

function classifyAction(move, agreement) {
  const symbol = UI_MOVES[move]?.symbol || move;
  if (symbol === agreement) return 'Cooperación';
  if (symbol === BEATS[agreement]) return 'Traición';
  if (symbol === LOSES_TO[agreement]) return 'No decisoria';
  throw new Error('Invalid player choice.');
}
function winnerOf(playerSymbol, machineSymbol) {
  if (playerSymbol === machineSymbol) return 'Empate';
  if (BEATS[playerSymbol] === machineSymbol) return 'Gana máquina';
  return 'Gana jugador';
}
function scoreRound(playerState, machineState, winner) {
  if (playerState === 'Cooperación' && machineState === 'Cooperación') return [3, 3];
  if (playerState === 'Traición' && machineState === 'Traición') return [1, 1];
  if (playerState === 'Traición' || machineState === 'Traición') {
    if (winner === 'Gana jugador') return [5, 0];
    if (winner === 'Gana máquina') return [0, 5];
  }
  return [0, 0];
}
function updatePolicyAfterPlayerAction(current, personalityName, playerState) {
  if (personalityName === 'indiferente' || playerState === 'No decisoria') return clonePolicy(current);
  let alpha, target;
  if (personalityName === 'reciproco') {
    if (playerState === 'Cooperación') {
      alpha = 0.35; target = [0.90, 0.05, 0.05];
    } else if (playerState === 'Traición') {
      alpha = 0.05; target = [0.15, 0.75, 0.10];
    } else return clonePolicy(current);
  } else if (personalityName === 'rencoroso') {
    if (playerState === 'Cooperación') {
      alpha = 0.03; target = [0.75, 0.15, 0.10];
    } else if (playerState === 'Traición') {
      alpha = 0.35; target = [0.025, 0.95, 0.025];
    } else return clonePolicy(current);
  } else return clonePolicy(current);

  const currentArray = [current.pc, current.pt, current.pn];
  const next = currentArray.map((value, i) => (1 - alpha) * value + alpha * target[i]);
  const total = next.reduce((sum, value) => sum + value, 0);
  return { pc: next[0] / total, pt: next[1] / total, pn: next[2] / total };
}
function probabilitiesForAgreement(currentPolicy, agreement) {
  return SYMBOLS.map(symbol => symbol === agreement
    ? currentPolicy.pc
    : symbol === BEATS[agreement]
      ? currentPolicy.pt
      : currentPolicy.pn);
}
function formatSymbol(symbol) {
  const meta = SYMBOL_META[symbol];
  return meta ? `${meta.emoji} ${meta.label}` : String(symbol || '—');
}
function formatAction(action) {
  if (action === 'Cooperación') return 'COOP.';
  if (action === 'Traición') return 'BETRAY';
  if (action === 'No decisoria') return 'NEUTRAL';
  return action || '—';
}
function probabilitySummary(p) {
  return `COOP ${(p.pc * 100).toFixed(1)}% · BETRAY ${(p.pt * 100).toFixed(1)}% · NEUTRAL ${(p.pn * 100).toFixed(1)}%`;
}
function updatePolicyDisplay(value) {
  const entries = [
    ['pc', value.pc, 'pcPct', 'pcBar'],
    ['pt', value.pt, 'ptPct', 'ptBar'],
    ['pn', value.pn, 'pnPct', 'pnBar']
  ];
  for (const [_key, probability, textId, barId] of entries) {
    if ($(textId)) $(textId).textContent = `${(probability * 100).toFixed(1)}%`;
    if ($(barId)) $(barId).style.width = `${Math.max(0, Math.min(100, probability * 100))}%`;
  }
}
function renderCircuit(probabilities, lastState = null) {
  const [pRock, pPaper, pScissors] = probabilities;
  const theta = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, pScissors))));
  const phi = 2 * Math.atan2(Math.sqrt(Math.max(0, pPaper)), Math.sqrt(Math.max(0, pRock)));
  const gateRows = [
    { label: 'q₁', gates: [`RY(${theta.toFixed(3)})`, 'X', '—', '●', '—', '●', 'X', 'M → c₁'] },
    { label: 'q₀', gates: ['—', '—', `RY(${(phi / 2).toFixed(3)})`, '⊕', `RY(${(-phi / 2).toFixed(3)})`, '⊕', '—', 'M → c₀'] }
  ];
  const container = $('circuitDiagram');
  if (container) {
    container.innerHTML = gateRows.map(row => `<div class="wire-label">${row.label}</div>${row.gates.map((gate, i) => {
      const cls = i === 0 || i === 2 || i === 4 ? 'rotation' : i === 3 || i === 5 ? 'control' : i === 7 ? 'measure' : '';
      return `<div class="circuit-gate ${cls} ${gate === '—' ? 'empty' : ''}" title="Step ${i + 1}: ${gate}">${gate === '—' ? '' : gate}</div>`;
    }).join('')}`).join('');
  }
  if ($('circuitMath')) {
    const measurementText = lastState ? ` Last measured bitstring: |${lastState}⟩.` : '';
    $('circuitMath').textContent = `P(rock)=${pRock.toFixed(4)}, P(paper)=${pPaper.toFixed(4)}, P(scissors)=${pScissors.toFixed(4)} · θ=2 asin√P(scissors)=${theta.toFixed(4)} rad · φ=2 atan2(√P(paper),√P(rock))=${phi.toFixed(4)} rad.${measurementText}`;
  }
}
function renderAgreement(agreement, index, stateText = '') {
  const meta = SYMBOL_META[agreement];
  if (!meta) return;
  $('agreementEmoji').textContent = meta.emoji;
  $('agreementName').textContent = meta.label;
  $('agreementRound').textContent = stateText || `ROUND ${index + 1} / ${TOTAL_ROUNDS} · Random pact for this round.`;
  const coop = agreement;
  const betray = BEATS[agreement];
  const neutral = LOSES_TO[agreement];
  $('agreementActions').innerHTML = `
    <div class="action-chip coop"><strong>COOPERATE</strong><span>${formatSymbol(coop)}<br>Match the pact.</span></div>
    <div class="action-chip betray"><strong>BETRAY</strong><span>${formatSymbol(betray)}<br>Beat the pact.</span></div>
    <div class="action-chip neutral"><strong>NEUTRAL / NO DECISION</strong><span>${formatSymbol(neutral)}<br>Lose to the pact.</span></div>`;
}
function renderHistory() {
  const body = $('historyBody');
  if (!body) return;
  if (!history.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-row">No rounds completed yet.</td></tr>';
  } else {
    body.innerHTML = history.slice().reverse().map(record => {
      const resultClass = record.winner === 'Gana jugador' ? 'won' : record.winner === 'Gana máquina' ? 'lost' : 'draw';
      const player = SYMBOL_META[record.playerSymbol];
      const machine = SYMBOL_META[record.machineSymbol];
      return `<tr title="Player: ${record.playerState}; Q-Bot: ${record.machineState}">
        <td>${String(record.round).padStart(2, '0')}</td>
        <td>${SYMBOL_META[record.agreement].emoji}</td>
        <td>${player.emoji} ${formatAction(record.playerState)}</td>
        <td>${machine.emoji} ${formatAction(record.machineState)}</td>
        <td class="${resultClass}">${record.playerPoints}/${record.machinePoints}</td></tr>`;
    }).join('');
  }
  const renderDots = key => Array.from({ length: TOTAL_ROUNDS }, (_, i) => {
    const record = history[i];
    const state = record?.[key];
    const css = state === 'Cooperación' ? 'coop' : state === 'Traición' ? 'betray' : state === 'No decisoria' ? 'neutral' : '';
    return `<span class="dot ${css}" title="Round ${i + 1}: ${state || 'not played'}"></span>`;
  }).join('');
  $('playerDots').innerHTML = renderDots('playerState');
  $('botDots').innerHTML = renderDots('machineState');
  $('ps').textContent = playerScore;
  $('bs').textContent = machineScore;
}
function currentSelectedPlanCount() { return mode === 'batch' ? plans.length : history.length; }
function renderCurrentRound() {
  updatePolicyDisplay(policy);
  renderHistory();
  const index = currentSelectedPlanCount();
  const moves = document.querySelectorAll('[data-m]');
  moves.forEach(button => {
    button.classList.remove('selected');
    button.disabled = busy || gameFinished || (mode === 'batch' && plans.length >= TOTAL_ROUNDS) || (mode === 'live' && history.length >= TOTAL_ROUNDS);
  });
  $('runBatch').hidden = !(mode === 'batch' && plans.length === TOTAL_ROUNDS && history.length === 0 && !gameFinished);
  $('finishMatch').hidden = !gameFinished;
  $('newAgreement').hidden = true;

  if (gameFinished) {
    $('roundLabel').textContent = `ROUND ${TOTAL_ROUNDS} / ${TOTAL_ROUNDS} — MATCH COMPLETE`;
    $('agreementEmoji').textContent = '✓';
    $('agreementName').textContent = 'ALL PACTS COMPLETE';
    $('agreementRound').textContent = 'All 15 quantum decisions have been measured.';
    $('agreementActions').innerHTML = '<div class="action-chip coop"><strong>COOPERATION</strong><span>Matched the agreement.</span></div><div class="action-chip betray"><strong>BETRAYAL</strong><span>Beat the agreement.</span></div><div class="action-chip neutral"><strong>NEUTRAL</strong><span>Lost to the agreement.</span></div>';
    $('machineMove').textContent = 'MATCH COMPLETE';
    $('botState').textContent = 'PERSONALITY STILL SECRET';
    return;
  }

  if (mode === 'batch' && plans.length === TOTAL_ROUNDS) {
    $('roundLabel').textContent = '15 / 15 DECISIONS SELECTED — READY TO RUN ONE QUANTUM JOB';
    $('agreementEmoji').textContent = '✓';
    $('agreementName').textContent = '15 DECISIONS READY';
    $('agreementRound').textContent = 'Press EXECUTE QUANTUM MATCH to run all 15 circuits as one backend job.';
    $('agreementActions').innerHTML = '<div class="action-chip coop"><strong>INPUTS READY</strong><span>All human choices recorded.</span></div><div class="action-chip betray"><strong>ONE JOB</strong><span>Compatible with IonQ remote simulators.</span></div><div class="action-chip neutral"><strong>WAITING</strong><span>Q-Bot decisions not measured yet.</span></div>';
    $('machineMove').textContent = 'AWAITING QUANTUM BATCH';
    $('botState').textContent = '15 CIRCUITS / ONE JOB';
    setNotice('All moves are recorded. Execute the single job to measure Q-Bot’s 15 decisions.', 'success');
    return;
  }

  const agreement = agreements[index];
  if (agreement) {
    const status = mode === 'batch'
      ? `BATCH SETUP · SELECT PLAYER MOVE ${index + 1} OF ${TOTAL_ROUNDS}. Machine replies appear after one combined quantum job.`
      : `LIVE MODE · ROUND ${index + 1} OF ${TOTAL_ROUNDS}. This mode sends one quantum job per round; use local simulators only.`;
    renderAgreement(agreement, index, status);
    const probabilities = probabilitiesForAgreement(policy, agreement);
    renderCircuit(probabilities, null);
    $('machineMove').textContent = mode === 'batch' ? 'AWAITING BATCH' : 'AWAITING MEASUREMENT';
    $('botState').textContent = `POLICY · ${probabilitySummary(policy)}`;
    $('roundLabel').textContent = mode === 'batch'
      ? `SELECT MOVE ${index + 1} / ${TOTAL_ROUNDS} — BATCH MODE`
      : `ROUND ${index + 1} / ${TOTAL_ROUNDS} — CHOOSE YOUR MOVE`;
    if (mode === 'batch') {
      $('playerState').textContent = `Move selections: ${plans.length}/${TOTAL_ROUNDS}`;
      setNotice('Select a symbol for the agreement shown. The machine adapts its probabilities to your choices; all measurements run together at the end.');
    } else {
      $('playerState').textContent = 'Choose a symbol';
      setNotice('Choose a symbol. Q-Bot will measure its two-qubit circuit and then reveal the round result.');
    }
  }
}
function stateForMeasuredString(rawState, probs) {
  const map = { '00': 'piedra', '01': 'papel', '10': 'tijeras' };
  const normalized = String(rawState).replace(/\s/g, '');
  if (map[normalized]) return { symbol: map[normalized], rawState: normalized, fallback: false };
  // The prepared ideal state assigns zero amplitude to |11>. A noisy backend
  // can nevertheless return it; use the highest-probability valid symbol and
  // preserve |11> in the record so the correction remains transparent.
  let bestIndex = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[bestIndex]) bestIndex = i;
  return { symbol: SYMBOLS[bestIndex], rawState: normalized, fallback: true };
}
function normalizePythonString(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.toJs === 'function') {
    const converted = value.toJs();
    if (typeof converted === 'string') return converted;
    return String(converted);
  }
  return String(value);
}
async function runQuantum(probabilityRows) {
  const json = JSON.stringify(probabilityRows);
  // callPromising is required for Qollab's IonQ backends; it bridges the Python
  // helper's backend.run/result call without XMLHttpRequest blocking errors.
  const response = await quantumEngine.run_quantum_batch.callPromising(backend, json);
  const text = normalizePythonString(response);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== probabilityRows.length) {
    throw new Error('Unexpected response from the quantum engine.');
  }
  return parsed;
}
function assembleRecord(plan, observation, scoresSoFar) {
  const measurement = stateForMeasuredString(observation.state, plan.symbolProbabilities);
  const machineSymbol = measurement.symbol;
  const machineState = classifyAction(machineSymbol, plan.agreement);
  const winner = winnerOf(plan.playerSymbol, machineSymbol);
  const [playerPoints, machinePoints] = scoreRound(plan.playerState, machineState, winner);
  return {
    round: plan.round,
    agreement: plan.agreement,
    playerSymbol: plan.playerSymbol,
    machineSymbol,
    playerState: plan.playerState,
    machineState,
    winner,
    playerPoints,
    machinePoints,
    rawMeasurement: measurement.rawState,
    usedNoiseFallback: measurement.fallback,
    operations: observation.operations,
    theta: observation.theta,
    phi: observation.phi,
    policyBefore: plan.policyBefore,
    symbolProbabilities: plan.symbolProbabilities
  };
}
function acceptRecord(record) {
  playerScore += record.playerPoints;
  machineScore += record.machinePoints;
  record.playerTotal = playerScore;
  record.machineTotal = machineScore;
  history.push(record);
}
function finishRounds() {
  gameFinished = true;
  $('finishMatch').hidden = false;
  $('machineMove').textContent = '15 MEASUREMENTS COMPLETE';
  $('botState').textContent = 'GUESS THE HIDDEN PERSONALITY';
  renderCurrentRound();
  setNotice('The match is complete. Review the record, then guess Q-Bot’s hidden personality for a +15-point bonus.', 'success');
}
async function chooseMove(move) {
  if (busy || gameFinished || !UI_MOVES[move]) return;
  if (mode === 'batch') {
    if (plans.length >= TOTAL_ROUNDS) return;
    const index = plans.length;
    const agreement = agreements[index];
    const playerState = classifyAction(move, agreement);
    const policyBefore = clonePolicy(policy);
    const symbolProbabilities = probabilitiesForAgreement(policyBefore, agreement);
    plans.push({
      round: index + 1,
      agreement,
      playerMove: move,
      playerSymbol: UI_MOVES[move].symbol,
      playerState,
      policyBefore,
      symbolProbabilities
    });
    policy = updatePolicyAfterPlayerAction(policy, personality, playerState);
    $('playerState').textContent = `${formatAction(playerState)} · ${UI_MOVES[move].emoji} ${UI_MOVES[move].label}`;
    document.querySelectorAll('[data-m]').forEach(button => button.classList.toggle('selected', button.dataset.m === move));
    playRoundSound();
    updatePolicyDisplay(policy);
    renderCurrentRound();
    return;
  }

  if (history.length >= TOTAL_ROUNDS) return;
  busy = true;
  document.querySelectorAll('[data-m]').forEach(button => { button.disabled = true; });
  const index = history.length;
  const agreement = agreements[index];
  const playerSymbol = UI_MOVES[move].symbol;
  const playerState = classifyAction(playerSymbol, agreement);
  const policyBefore = clonePolicy(policy);
  const symbolProbabilities = probabilitiesForAgreement(policyBefore, agreement);
  $('playerState').textContent = `${formatAction(playerState)} · ${UI_MOVES[move].emoji} ${UI_MOVES[move].label}`;
  $('botState').textContent = 'SUBMITTING QUANTUM CIRCUIT…';
  $('machineMove').textContent = 'MEASURING…';
  renderCircuit(symbolProbabilities);
  setNotice('Submitting one two-qubit circuit to the selected Qollab backend…');
  try {
    const observations = await runQuantum([symbolProbabilities]);
    const plan = { round: index + 1, agreement, playerMove: move, playerSymbol, playerState, policyBefore, symbolProbabilities };
    const record = assembleRecord(plan, observations[0]);
    acceptRecord(record);
    policy = updatePolicyAfterPlayerAction(policy, personality, playerState);
    roundIndex = history.length;
    playRoundSound();
    displayLatestRecord(record);
    renderHistory();
    updatePolicyDisplay(policy);
    if (history.length >= TOTAL_ROUNDS) finishRounds();
    else {
      renderCurrentRound();
      setNotice(`Round ${record.round} measured. Q-Bot's policy has been updated for the next round.`, 'success');
    }
  } catch (error) {
    setNotice(`Quantum run failed: ${error?.message || error}. If you selected an IonQ backend, restart using FULL MATCH / ONE QUANTUM JOB mode.`, 'error');
    $('botState').textContent = 'QUANTUM JOB FAILED';
  } finally {
    busy = false;
    if (!gameFinished) renderCurrentRound();
  }
}
function displayLatestRecord(record) {
  const playerMeta = SYMBOL_META[record.playerSymbol];
  const machineMeta = SYMBOL_META[record.machineSymbol];
  $('machineMove').textContent = `${machineMeta.emoji} ${machineMeta.label}`;
  $('measurementState').textContent = `Measured |${record.rawMeasurement}⟩${record.usedNoiseFallback ? ' · noisy invalid state; used highest-probability fallback' : ''}`;
  $('botState').textContent = `${formatAction(record.machineState)} · P(rock/paper/scissors) ${record.symbolProbabilities.map(p => `${(p*100).toFixed(0)}%`).join('/')}`;
  $('playerState').textContent = `${formatAction(record.playerState)} · ${playerMeta.emoji} ${playerMeta.label}`;
  renderCircuit(record.symbolProbabilities, record.rawMeasurement);
  if (record.usedNoiseFallback) setNotice('The backend measured |11⟩, which has zero ideal amplitude in this circuit. The UI transparently used the highest-probability valid symbol as a fallback.', 'error');
}
async function executeBatchMatch() {
  if (busy || mode !== 'batch' || plans.length !== TOTAL_ROUNDS || gameFinished) return;
  busy = true;
  $('runBatch').disabled = true;
  $('botState').textContent = 'SUBMITTING 15 CIRCUITS…';
  $('machineMove').textContent = 'ONE QUANTUM JOB';
  setNotice('Submitting all 15 circuits as one job. This is the mode to use with IonQ remote simulators.');
  const rows = plans.map(plan => plan.symbolProbabilities);
  // This is a single call to backend.run for every round in the match.
  try {
    const observations = await runQuantum(rows);
    playerScore = 0;
    machineScore = 0;
    history = [];
    for (let i = 0; i < plans.length; i++) {
      const record = assembleRecord(plans[i], observations[i]);
      acceptRecord(record);
    }
    const last = history[history.length - 1];
    displayLatestRecord(last);
    $('measurementState').textContent = `BATCH COMPLETE · last state |${last.rawMeasurement}⟩ · ${history.length} circuits measured in one job`;
    renderHistory();
    updatePolicyDisplay(policy);
    finishRounds();
  } catch (error) {
    setNotice(`Quantum batch failed: ${error?.message || error}. Try the built-in simulator first, then retry on a free IonQ simulator.`, 'error');
    $('botState').textContent = 'QUANTUM BATCH FAILED';
    $('runBatch').disabled = false;
  } finally {
    busy = false;
  }
}
function startNewGame() {
  mode = $('executionMode').value;
  agreements = Array.from({ length: TOTAL_ROUNDS }, () => randChoice(SYMBOLS));
  plans = [];
  history = [];
  roundIndex = 0;
  playerScore = 0;
  machineScore = 0;
  personality = randChoice(PERSONALITIES);
  policy = { pc: 1 / 3, pt: 1 / 3, pn: 1 / 3 };
  busy = false;
  gameFinished = false;
  guessSubmitted = false;
  document.querySelectorAll('[data-m]').forEach(button => { button.disabled = false; button.classList.remove('selected'); });
  $('runBatch').disabled = false;
  $('machineMove').textContent = mode === 'batch' ? 'AWAITING BATCH' : 'AWAITING MEASUREMENT';
  $('measurementState').textContent = 'Measurement: —';
  $('botState').textContent = 'PERSONALITY UNKNOWN';
  $('playerState').textContent = 'Choose a symbol';
  $('guessResult').textContent = 'Correct guess: +15 bonus points.';
  document.querySelectorAll('[data-personality]').forEach(button => { button.disabled = false; });
  $('endtitle').textContent = '15 ROUNDS COMPLETE';
  $('endscore').textContent = '';
  $('guessPanel').classList.remove('hidden');
  unlockAudio();
  showScreen('game');
  renderCurrentRound();
  if (mode === 'batch') {
    setNotice('BATCH MODE: select one move for every agreement. All 15 adaptive circuits are submitted together as one backend job.', 'success');
  } else {
    setNotice('LIVE MODE: one circuit is submitted per round. Use a local simulator; IonQ allows one quantum job per project run.', 'success');
  }
}
function showFinalGuess() {
  showScreen('ending');
  $('guessPanel').classList.remove('hidden');
  $('endtitle').textContent = '15 ROUNDS COMPLETE';
  $('endscore').innerHTML = `PLAYER 1: ${playerScore} PTS<br>Q-BOT: ${machineScore} PTS<br><small>GUESS THE PERSONALITY FOR +15</small>`;
}
async function submitPersonalityGuess(guess) {
  if (!gameFinished || guessSubmitted) return;
  guessSubmitted = true;
  const correct = guess === personality;
  if (correct) playerScore += 15;
  document.querySelectorAll('[data-personality]').forEach(button => {
    button.disabled = true;
    button.classList.toggle('selected', button.dataset.personality === guess);
  });
  $('guessResult').textContent = correct
    ? `CORRECT! +15 BONUS. Q-BOT WAS ${PERSONALITY_LABELS[personality]}.`
    : `NOT QUITE. Q-BOT WAS ${PERSONALITY_LABELS[personality]}.`;
  const finalTitle = playerScore > machineScore ? 'CONGRATULATIONS! YOU WIN!' : playerScore < machineScore ? 'Q-BOT WINS THIS MATCH' : 'IT’S A TIE!';
  $('endtitle').textContent = finalTitle;
  $('endscore').innerHTML = `PLAYER 1: ${playerScore} PTS<br>Q-BOT: ${machineScore} PTS<br><small>${correct ? 'PERSONALITY IDENTIFIED' : 'PERSONALITY REVEALED'}</small>`;
}
function resetToIntro() {
  busy = false;
  plans = [];
  history = [];
  gameFinished = false;
  guessSubmitted = false;
  showScreen('intro');
}

$('start').addEventListener('click', startNewGame);
document.querySelectorAll('[data-m]').forEach(button => button.addEventListener('click', () => chooseMove(button.dataset.m)));
$('runBatch').addEventListener('click', executeBatchMatch);
$('finishMatch').addEventListener('click', showFinalGuess);
$('backToIntro').addEventListener('click', resetToIntro);
$('restart').addEventListener('click', resetToIntro);
document.querySelectorAll('[data-personality]').forEach(button => button.addEventListener('click', () => submitPersonalityGuess(button.dataset.personality)));
$('executionMode').addEventListener('change', () => {
  $('modeHelp').textContent = $('executionMode').value === 'batch'
    ? 'Choose all 15 moves, then execute all 15 circuits in one job. Compatible with IonQ\'s one-job-per-run limit.'
    : 'Get the machine result after every move. Use a built-in, AWS Braket or IBM local simulator; remote IonQ allows one job per project run.';
});

renderCircuit([1/3, 1/3, 1/3]);
updatePolicyDisplay(policy);
console.log('Quantum Arcade Qollab UI ready. Qiskit backend is selected when Run Project is launched.');
