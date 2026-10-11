/*
 * Puente LOCAL entre Quantum Arcade y el VQC Python.
 * - Inserta la cámara Python dentro del panel de PLAYER 1.
 * - Conserva los botones manuales si Python/cámara no están disponibles.
 * - Convierte cada evento estable del VQC en una jugada del juego.
 * - Abre VQC LAB en un modal e informa claramente si el servidor no responde.
 * No usa bibliotecas, CDN ni servicios externos.
 */
(() => {
  "use strict";

  const API_BASE = (
    window.location.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(window.location.hostname)
  ) ? window.location.origin : "http://127.0.0.1:8765";

  const BUTTON_ID = "vqcExploreButton";
  const MODAL_ID = "vqcModal";
  const FRAME_ID = "vqcFrame";
  const CLOSE_ID = "vqcCloseButton";
  const CAMERA_BOX_ID = "qaCameraViewport";

  let serverConnected = false;
  let cameraAvailable = false;
  let cameraEnabled = false;
  let hasInitialEventId = false;
  let lastGestureEventId = 0;
  let frameTimer = null;
  let pollingBusy = false;
  let currentGameState = null;
  let roundSubmissionBusy = false;
  let roundAudioContext = null;

  const $ = id => document.getElementById(id);
  const SYMBOL = {
    piedra: { label: "ROCK", emoji: "✊", move: "rock" },
    papel: { label: "PAPER", emoji: "✋", move: "paper" },
    tijeras: { label: "SCISSORS", emoji: "✌", move: "scissors" }
  };
  const PERSONALITY_LABELS = {
    indiferente: "INDIFERENTE",
    reciproco: "RECÍPROCA",
    rencoroso: "RENCOROSA"
  };

  function statusText(message) {
    const node = $("integrationStatus");
    if (node) node.textContent = message;
  }

  function installStyles() {
    if ($("quantum-arcade-vqc-style")) return;
    const style = document.createElement("style");
    style.id = "quantum-arcade-vqc-style";
    style.textContent = `
      .qa-camera-character {
        display:flex !important; align-items:stretch !important; justify-content:stretch !important;
        min-width:0; min-height:0; width:100%; height:236px; padding:0; margin:0;
        overflow:hidden; filter:none !important; font-size:14px !important;
      }
      #${CAMERA_BOX_ID} {
        position:relative; width:100%; height:100%; min-width:0; overflow:hidden;
        border:1px solid #47f3ff; background:#09091d; box-shadow:inset 0 0 16px #47f3ff15;
      }
      #qaCameraFeed { display:none; width:100%; height:100%; object-fit:cover; }
      #${CAMERA_BOX_ID}.has-frame #qaCameraFeed { display:block; }
      #qaCameraPlaceholder {
        position:absolute; inset:0; display:flex; flex-direction:column; align-items:center;
        justify-content:center; gap:10px; padding:10px; text-align:center; color:#b8b0d0;
        font:10px 'Share Tech Mono',monospace; line-height:1.6; background:#09091d;
      }
      #${CAMERA_BOX_ID}.has-frame #qaCameraPlaceholder { display:none; }
      #qaCameraPlaceholder .qa-camera-icon { color:#47f3ff; font-size:34px; }
      #qaCameraBadge {
        position:absolute; left:6px; top:6px; z-index:2; padding:4px 6px;
        background:#100b26e8; border:1px solid #47f3ff; color:#47f3ff;
        font:8px 'Press Start 2P',monospace; line-height:1.6;
      }
      #qaCameraResult {
        position:absolute; left:6px; right:6px; bottom:6px; z-index:2; padding:5px 6px;
        border:1px solid #f04be8; background:#100b26e8; color:#fff0ce;
        font:9px 'Press Start 2P',monospace; text-align:center; line-height:1.8;
      }
      #${BUTTON_ID} { margin-left:4px; }
      #${MODAL_ID}[hidden] { display:none !important; }
      #${MODAL_ID} {
        position:fixed; inset:0; z-index:99999; display:grid; place-items:center;
        padding:2vh 2vw; background:#070510ed; backdrop-filter:blur(8px);
      }
      #${MODAL_ID} .vqc-modal-content {
        position:relative; display:flex; flex-direction:column; width:min(1500px,97vw);
        height:94vh; overflow:hidden; border:2px solid #47f3ff; background:#0b1020;
        box-shadow:0 0 24px #47f3ff44,8px 8px #070510;
      }
      #${MODAL_ID} .vqc-modal-topline {
        min-height:44px; padding:6px 10px 6px 15px; display:flex; align-items:center;
        justify-content:space-between; gap:12px; color:#47f3ff; background:#100b26;
        border-bottom:1px solid #49305f; font:10px 'Press Start 2P',monospace;
      }
      #${MODAL_ID} .vqc-close { font-size:9px !important; padding:9px 12px !important; }
      #${FRAME_ID} { display:block; width:100%; height:100%; flex:1; border:0; background:#0b1020; }
      #qaVqcOffline {
        display:none; flex:1; padding:24px; color:#fff0ce; background:#100b26;
        font:16px 'Share Tech Mono',monospace; line-height:1.8; overflow:auto;
      }
      #qaVqcOffline strong { color:#47f3ff; }
      #qaAgreementPanel {
        border:2px solid #ffd34f; background:#1a1034e8; padding:12px 16px;
        box-shadow:0 0 14px #ffd34f18; display:grid; grid-template-columns:minmax(180px, .85fr) 2fr;
        gap:12px; align-items:center;
      }
      .qa-agreement-main { display:flex; align-items:center; gap:12px; }
      .qa-agreement-symbol { font-size:42px; line-height:1; color:#ffd34f; text-shadow:0 0 12px #ffd34f55; }
      .qa-agreement-label { font:10px 'Press Start 2P',monospace; color:#ffd34f; line-height:1.9; }
      .qa-agreement-sub { color:#b8b0d0; font-size:12px; margin-top:3px; }
      .qa-agreement-actions { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
      .qa-action-chip { border:1px solid #49305f; background:#100b26; padding:8px; min-width:0; line-height:1.5; }
      .qa-action-chip strong { display:block; font:8px 'Press Start 2P',monospace; margin-bottom:5px; }
      .qa-action-chip span { display:block; font-size:12px; overflow-wrap:anywhere; }
      .qa-action-chip.coop strong { color:#35f16c; }
      .qa-action-chip.betray strong { color:#ff3857; }
      .qa-action-chip.neutral strong { color:#47f3ff; }
      #qaGameMeta { grid-column:1/-1; border-top:1px solid #49305f; padding-top:8px; display:flex; gap:15px; flex-wrap:wrap; align-items:center; }
      #qaMachineOdds { color:#47f3ff; font-size:12px; line-height:1.7; }
      #qaQuantumShot { color:#ffd34f; font-size:12px; line-height:1.7; margin-top:3px; }
      #qaRoundResult { color:#fff0ce; font-size:13px; line-height:1.7; margin-left:auto; text-align:right; }
      #qaAgreementPanel .qa-scoring { color:#b8b0d0; font-size:11px; line-height:1.6; }
      #qaPersonalityGuessPanel { border:2px solid #47f3ff; background:#1a1034; padding:14px; margin:12px 0; max-width:min(700px,92vw); }
      #qaPersonalityGuessPanel .qa-guess-title { color:#47f3ff; font:10px 'Press Start 2P',monospace; line-height:1.8; }
      #qaPersonalityGuessPanel .qa-guess-options { display:flex; gap:8px; flex-wrap:wrap; justify-content:center; margin:12px 0; }
      #qaPersonalityGuessPanel .qa-guess-options .arcade { font-size:9px; padding:12px; }
      #qaGuessResult { line-height:1.8; }
      .qa-dot-coop { background:#35f16c !important; box-shadow:0 0 7px #35f16c66; }
      .qa-dot-betray { background:#ff3857 !important; box-shadow:0 0 7px #ff385766; }
      .qa-dot-neutral { background:#47f3ff !important; box-shadow:0 0 7px #47f3ff66; }
      @media(max-width:760px) {
        #qaAgreementPanel { grid-template-columns:1fr; }
        #qaGameMeta { display:block; }
        #qaRoundResult { text-align:left; margin-top:6px; }
      }
      @media(max-width:620px) {
        .qa-camera-character { height:215px; }
        #${MODAL_ID} { padding:0; }
        #${MODAL_ID} .vqc-modal-content { width:100vw; height:100dvh; border-width:1px; }
        #${MODAL_ID} .vqc-modal-topline { font-size:8px; }
      }
    `;
    document.head.appendChild(style);
  }

  function installPlayerCamera() {
    const character = document.querySelector(".playerframe .character");
    if (!character || $(CAMERA_BOX_ID)) return;
    character.classList.add("qa-camera-character");
    character.setAttribute("aria-label", "Cámara de PLAYER 1");
    character.innerHTML = `
      <div id="${CAMERA_BOX_ID}">
        <img id="qaCameraFeed" alt="Imagen de la cámara local de Player 1">
        <div id="qaCameraPlaceholder">
          <div class="qa-camera-icon">◎</div>
          <div id="qaCameraPlaceholderText">CAMERA OFF<br>Activa CAMERA: ON<br>o elige con el mouse.</div>
        </div>
        <div id="qaCameraBadge">PLAYER 1 / VISION</div>
        <div id="qaCameraResult">ESPERANDO GESTO</div>
      </div>`;
  }

  function setCameraUi() {
    const button = $("cameraToggle");
    const box = $(CAMERA_BOX_ID);
    const placeholder = $("qaCameraPlaceholderText");
    if (button) button.textContent = `CAMERA: ${cameraEnabled ? "ON" : "OFF"}`;

    if (box && placeholder) {
      box.classList.toggle("camera-enabled", cameraEnabled && cameraAvailable);
      if (!serverConnected) {
        placeholder.innerHTML = "PYTHON NO CONECTADO<br>Los botones manuales siguen disponibles.";
      } else if (!cameraAvailable) {
        placeholder.innerHTML = "CÁMARA NO DISPONIBLE<br>Usa las opciones con el mouse.";
      } else if (!cameraEnabled) {
        placeholder.innerHTML = "CAMERA OFF<br>Pulsa CAMERA: ON<br>o elige con el mouse.";
      } else {
        placeholder.innerHTML = "CONECTANDO CÁMARA...<br>Los botones manuales siguen disponibles.";
      }
    }
    if (!serverConnected) {
      statusText("Python no conectado · puedes jugar usando los botones manuales.");
    } else if (!cameraAvailable) {
      statusText("Servidor local activo · cámara no disponible · controles manuales activos.");
    } else if (cameraEnabled) {
      statusText("Modelo VQC local conectado · cámara activa · esperando un gesto estable.");
    } else {
      statusText("Modelo VQC local conectado · cámara apagada · controles manuales disponibles.");
    }
  }

  async function requestCameraState(enabled) {
    try {
      const response = await fetch(`${API_BASE}/api/camera/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
        cache: "no-store"
      });
      const data = await response.json();
      serverConnected = true;
      cameraAvailable = Boolean(data.camera_available);
      cameraEnabled = Boolean(data.camera_enabled);
      setCameraUi();
      if (!response.ok) {
        statusText(data.error || "La cámara de Python no está disponible. Usa los botones manuales.");
      }
    } catch (_error) {
      serverConnected = false;
      cameraAvailable = false;
      cameraEnabled = false;
      setCameraUi();
      statusText("No se pudo conectar con Python. Los botones manuales siguen disponibles.");
    }
  }

  function refreshCameraFrame() {
    const box = $(CAMERA_BOX_ID);
    const img = $("qaCameraFeed");
    if (!box || !img) return;

    if (!serverConnected || !cameraAvailable || !cameraEnabled) {
      if (img.dataset.streaming === "true") {
        img.removeAttribute("src"); // cierra el flujo MJPEG en el servidor
        img.dataset.streaming = "false";
      }
      box.classList.remove("has-frame");
      return;
    }

    // Se abre una sola conexión de vídeo; el servidor envía fotogramas continuamente.
    if (img.dataset.streaming !== "true") {
      img.onload = () => box.classList.add("has-frame");
      img.onerror = () => {
        box.classList.remove("has-frame");
        img.dataset.streaming = "false";
      };
      img.dataset.streaming = "true";
      img.src = `${API_BASE}/camera.mjpg`;
    }
  }

  function installLabModal() {
    if ($(BUTTON_ID)) return;
    const cameraButton = $("cameraToggle");
    if (!cameraButton) return;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.id = BUTTON_ID;
    openButton.className = "arcade";
    openButton.textContent = "VQC LAB ◈";
    openButton.setAttribute("aria-controls", MODAL_ID);
    openButton.setAttribute("aria-expanded", "false");
    openButton.style.cssText = "font-size:10px;padding:12px 14px";
    cameraButton.insertAdjacentElement("afterend", openButton);

    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="vqc-modal-content" role="dialog" aria-modal="true" aria-label="Laboratorio educativo del VQC">
        <div class="vqc-modal-topline">
          <span>QUANTUM ARCADE / VQC LAB</span>
          <button id="${CLOSE_ID}" class="arcade vqc-close" type="button">CLOSE ✕</button>
        </div>
        <iframe id="${FRAME_ID}" title="Laboratorio educativo del VQC" loading="lazy" src="about:blank"></iframe>
        <div id="qaVqcOffline"><strong>VQC LAB SIN CONEXIÓN</strong><br><br>
          Ejecuta el script Python principal y espera a que muestre la dirección local.<br><br>
          Abre el videojuego desde <strong>http://127.0.0.1:8765/game</strong>.<br>
          El laboratorio y el modelo funcionan localmente; no hace falta Internet.
        </div>
      </div>`;
    document.body.appendChild(modal);
    const frame = $(FRAME_ID);
    const closeButton = $(CLOSE_ID);
    const offline = $("qaVqcOffline");

    async function openLab() {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
      openButton.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
      closeButton.focus();
      offline.style.display = "none";
      frame.style.display = "block";
      try {
        const response = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
        if (!response.ok) throw new Error("bridge off");
        frame.src = `${API_BASE}/embed`;
      } catch (_error) {
        frame.src = "about:blank";
        frame.style.display = "none";
        offline.style.display = "block";
      }
    }

    function closeLab() {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
      openButton.setAttribute("aria-expanded", "false");
      frame.src = "about:blank";
      document.body.style.overflow = "";
      openButton.focus();
    }
    openButton.addEventListener("click", openLab);
    closeButton.addEventListener("click", closeLab);
    modal.addEventListener("click", event => { if (event.target === modal) closeLab(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !modal.hidden) closeLab(); });
  }

  async function pollPythonState() {
    if (pollingBusy) return;
    pollingBusy = true;
    try {
      const response = await fetch(`${API_BASE}/api/state`, { cache: "no-store" });
      if (!response.ok) throw new Error("local API unavailable");
      const state = await response.json();
      serverConnected = true;
      cameraAvailable = Boolean(state.camera_available);
      cameraEnabled = Boolean(state.camera_enabled);
      setCameraUi();

      const result = $("qaCameraResult");
      if (result) {
        result.textContent = cameraEnabled
          ? (state.stable_label || state.status_label || "ESPERANDO GESTO")
          : "ESPERANDO GESTO";
      }

      const gameIsVisible = $("game")?.classList.contains("active");
      if (!gameIsVisible && cameraEnabled) {
        // No dejar el reconocimiento armado en la pantalla de introducción/final.
        cameraEnabled = false;
        requestCameraState(false);
      }

      const eventId = Number(state.gesture_event_id || 0);
      if (!hasInitialEventId) {
        // No repetir una jugada antigua al abrir/recargar la página.
        lastGestureEventId = eventId;
        hasInitialEventId = true;
      } else if (eventId > lastGestureEventId) {
        lastGestureEventId = eventId;
        const move = state.gesture_event;
        const inGame = $("game")?.classList.contains("active");
        const roundBusy = Array.from(document.querySelectorAll("[data-m]"))
          .some(button => button.disabled);
        if (inGame && !roundBusy && ["rock", "paper", "scissors"].includes(move)) {
          // La cámara y el mouse envían la decisión al mismo motor de acuerdos local.
          submitMove(move, "camera");
        }
      }
    } catch (_error) {
      serverConnected = false;
      cameraAvailable = false;
      cameraEnabled = false;
      setCameraUi();
    } finally {
      pollingBusy = false;
    }
  }

  function installAgreementPanel() {
    if ($("qaAgreementPanel")) return;
    const game = $("game");
    const header = game?.querySelector(".head");
    if (!game || !header) return;
    const panel = document.createElement("section");
    panel.id = "qaAgreementPanel";
    panel.innerHTML = `
      <div class="qa-agreement-main">
        <div class="qa-agreement-symbol" id="qaAgreementEmoji">🎲</div>
        <div>
          <div class="qa-agreement-label">PACT / ACUERDO</div>
          <div id="qaAgreementName" style="font:12px 'Press Start 2P',monospace;line-height:1.8">ESPERANDO PARTIDA</div>
          <div class="qa-agreement-sub" id="qaAgreementRound">El acuerdo cambia cada ronda.</div>
        </div>
      </div>
      <div class="qa-agreement-actions" id="qaAgreementActions">
        <div class="qa-action-chip coop"><strong>COOPERAR</strong><span>Elegir el acuerdo</span></div>
        <div class="qa-action-chip betray"><strong>TRAICIONAR</strong><span>Vencer al acuerdo</span></div>
        <div class="qa-action-chip neutral"><strong>NEUTRAL / NO DECISORIA</strong><span>Perder contra el acuerdo</span></div>
      </div>
      <div id="qaGameMeta">
        <div class="qa-scoring">PUNTOS: ambos cooperan = +3 cada uno · ambos traicionan = +1 cada uno · traición con ganador = +5 al ganador · demás casos = 0.</div>
        <div id="qaMachineOdds">Probabilidades iniciales de Q-BOT: cooperación 33% · traición 33% · no decisoria 33%.</div>
        <div id="qaQuantumShot">Circuito de estrategia: 2 qubits · AerSimulator local · 1 shot por ronda.</div>
        <div id="qaRoundResult" aria-live="polite">Elige con la cámara o con el mouse.</div>
      </div>`;
    header.insertAdjacentElement("afterend", panel);

    const tableHead = $("hist")?.closest("table")?.querySelector("thead");
    if (tableHead) {
      tableHead.innerHTML = `<tr><th>RND</th><th>PACTO</th><th>JUGADOR</th><th>Q-BOT</th><th>PTS J/M</th></tr>`;
    }
    const scoreLabels = document.querySelectorAll(".player .score");
    scoreLabels.forEach((node, index) => {
      const id = index === 0 ? "ps" : "bs";
      node.innerHTML = `PTS: <b id="${id}">0</b>`;
    });
  }

  function installIntroRules() {
    const subtitle = document.querySelector("#intro .sub");
    if (subtitle) subtitle.textContent = "A RANDOM PACT. THREE CHOICES. A QUANTUM OPPONENT.";
    if ($("qaIntroRules")) return;
    const intro = $("intro");
    const start = $("start");
    if (!intro || !start) return;
    const rules = document.createElement("p");
    rules.id = "qaIntroRules";
    rules.style.cssText = "max-width:760px;margin:0 auto 24px;color:#b8b0d0;font-size:14px;line-height:1.8";
    rules.innerHTML = "Cada ronda sortea un acuerdo: <b style='color:#35f16c'>cooperar</b> si lo igualas, <b style='color:#ff3857'>traicionar</b> si lo vences o <b style='color:#47f3ff'>neutral</b> si pierdes contra él. La máquina adapta su estrategia según tus decisiones. Al final, intenta descubrir su personalidad.";
    start.insertAdjacentElement("beforebegin", rules);
  }

  function installPersonalityGuessPanel() {
    if ($("qaPersonalityGuessPanel")) return;
    const ending = $("ending");
    const restart = $("restart");
    if (!ending || !restart) return;
    const panel = document.createElement("div");
    panel.id = "qaPersonalityGuessPanel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="qa-guess-title">FINAL / ADIVINA LA PERSONALIDAD</div>
      <div style="margin-top:7px">¿Qué estrategia secreta utilizó Q-BOT?</div>
      <div class="qa-guess-options">
        <button class="arcade" type="button" data-personality="indiferente">INDIFERENTE</button>
        <button class="arcade" type="button" data-personality="reciproco">RECÍPROCA</button>
        <button class="arcade" type="button" data-personality="rencoroso">RENCOROSA</button>
      </div>
      <div id="qaGuessResult" aria-live="polite">Acierta para ganar 15 puntos extra.</div>`;
    restart.insertAdjacentElement("beforebegin", panel);
  }

  function fmtSymbol(symbol) {
    const meta = SYMBOL[symbol];
    return meta ? `${meta.emoji} ${meta.label}` : "—";
  }
  function fmtAction(state) {
    if (state === "Cooperación") return "COOPERACIÓN";
    if (state === "Traición") return "TRAICIÓN";
    if (state === "No decisoria") return "NO DECISORIA";
    return state || "—";
  }
  function getActionSymbols(agreement) {
    const beats = { piedra: "papel", papel: "tijeras", tijeras: "piedra" };
    const loses = { piedra: "tijeras", papel: "piedra", tijeras: "papel" };
    if (!SYMBOL[agreement]) return null;
    return { cooperation: agreement, betrayal: beats[agreement], noDecision: loses[agreement] };
  }
  function updateAgreementPanel(state) {
    const emoji = $("qaAgreementEmoji");
    const name = $("qaAgreementName");
    const sub = $("qaAgreementRound");
    const actions = $("qaAgreementActions");
    const odds = $("qaMachineOdds");
    if (!emoji || !name || !sub || !actions) return;

    if (state.game_over || !state.current_agreement) {
      emoji.textContent = "✓";
      name.textContent = "ACUERDOS COMPLETADOS";
      sub.textContent = "Las 15 rondas han terminado. Adivina la personalidad de Q-BOT.";
      actions.innerHTML = `<div class="qa-action-chip coop"><strong>COOPERACIÓN</strong><span>Ambos coinciden con el acuerdo: +3 cada uno si ambos cooperan.</span></div><div class="qa-action-chip betray"><strong>TRAICIÓN</strong><span>Ambos traicionan: +1 cada uno; si hay ganador y alguien traiciona, +5 al ganador.</span></div><div class="qa-action-chip neutral"><strong>NO DECISORIA</strong><span>Elige el símbolo que pierde ante el acuerdo.</span></div>`;
      if (odds) odds.textContent = "La personalidad se revela después de tu elección final.";
      const shot = $("qaQuantumShot");
      if (shot) shot.textContent = "15 rondas completadas · el motor cuántico utilizó una medición por jugada.";
      return;
    }

    const agreement = state.current_agreement;
    const symbols = getActionSymbols(agreement);
    emoji.textContent = SYMBOL[agreement].emoji;
    name.textContent = SYMBOL[agreement].label;
    sub.textContent = `RONDA ${state.round_number} / ${state.total_rounds} · Este pacto es aleatorio y solo vale para esta ronda.`;
    actions.innerHTML = `
      <div class="qa-action-chip coop"><strong>COOPERAR</strong><span>${fmtSymbol(symbols.cooperation)}<br>Igualar el acuerdo</span></div>
      <div class="qa-action-chip betray"><strong>TRAICIONAR</strong><span>${fmtSymbol(symbols.betrayal)}<br>Vencer al acuerdo</span></div>
      <div class="qa-action-chip neutral"><strong>NEUTRAL / NO DECISORIA</strong><span>${fmtSymbol(symbols.noDecision)}<br>Perder ante el acuerdo</span></div>`;
    const p = state.strategy_probabilities;
    if (odds && p) {
      odds.textContent = `ESTRATEGIA ACTUAL DE Q-BOT · Cooperar ${(p.cooperation*100).toFixed(1)}% · Traicionar ${(p.betrayal*100).toFixed(1)}% · No decisoria ${(p.no_decision*100).toFixed(1)}%`;
    }
  }

  function renderGameState(state) {
    currentGameState = state;
    const total = Number(state.total_rounds || 15);
    const completed = Number(state.rounds_completed || 0);
    if ($("ps")) $("ps").textContent = state.scores?.player ?? 0;
    if ($("bs")) $("bs").textContent = state.scores?.machine ?? 0;
    if ($("roundlabel")) {
      $("roundlabel").textContent = state.game_over
        ? `ROUND ${total} / ${total} — MATCH COMPLETE / ADIVINA LA PERSONALIDAD`
        : `ROUND ${state.round_number} / ${total} — ELIGE TU JUGADA PARA EL ACUERDO ACTUAL`;
    }
    updateAgreementPanel(state);

    const last = state.last_record;
    const quantumShot = $("qaQuantumShot");
    if (last && quantumShot) {
      quantumShot.textContent = `MEDICIÓN CUÁNTICA: |${last.quantum_measurement}⟩ → ${fmtSymbol(last.machine_move)} · ${last.quantum_operations} operaciones en el circuito de 2 qubits (simulación local).`;
    } else if (quantumShot) {
      quantumShot.textContent = "Circuito de estrategia: 2 qubits · AerSimulator local · 1 shot por ronda.";
    }
    if (last) {
      const playerMove = SYMBOL[last.player_move];
      const machineMove = SYMBOL[last.machine_move];
      if ($("state")) $("state").textContent = `${fmtAction(last.player_state)} · ${playerMove?.emoji || ""} ${playerMove?.label || last.player_move}`;
      if ($("botstate")) $("botstate").textContent = `${fmtAction(last.machine_state)} · ${machineMove?.emoji || ""} ${machineMove?.label || last.machine_move}`;
      const result = $("qaRoundResult");
      if (result) {
        const winnerText = last.winner === "Gana jugador" ? "GANA PLAYER 1" : last.winner === "Gana máquina" ? "GANA Q-BOT" : "EMPATE";
        result.textContent = `R${last.round}: ${winnerText} · Puntos de ronda ${last.player_points} / ${last.machine_points}`;
      }
    } else {
      if ($("state")) $("state").textContent = "READY / ESPERANDO JUGADA";
      if ($("botstate")) $("botstate").textContent = "PERSONALIDAD SECRETA · QUBIT SAMPLING";
    }

    const hist = $("hist");
    if (hist) {
      hist.innerHTML = (state.history || []).slice().reverse().map(r => {
        const winner = r.winner === "Gana jugador" ? "P1 +" : r.winner === "Gana máquina" ? "BOT +" : "DRAW";
        const cls = r.winner === "Gana jugador" ? "won" : r.winner === "Gana máquina" ? "lost" : "draw";
        const ag = SYMBOL[r.agreement]?.emoji || "?";
        const pl = SYMBOL[r.player_move]?.emoji || "?";
        const mb = SYMBOL[r.machine_move]?.emoji || "?";
        return `<tr title="Player: ${fmtAction(r.player_state)} · Q-Bot: ${fmtAction(r.machine_state)}"><td>${String(r.round).padStart(2,"0")}</td><td>${ag} ${SYMBOL[r.agreement]?.label || r.agreement}</td><td>${pl} ${fmtAction(r.player_state)}</td><td>${mb} ${fmtAction(r.machine_state)}</td><td class="${cls}">${r.player_points}/${r.machine_points}</td></tr>`;
      }).join("");
    }

    const playerDots = $("pdots"), botDots = $("bdots");
    const renderDots = (rows, key) => Array.from({length: total}, (_, i) => {
      const rec = (state.history || [])[i];
      const action = rec?.[key];
      const css = action === "Cooperación" ? "qa-dot-coop" : action === "Traición" ? "qa-dot-betray" : action === "No decisoria" ? "qa-dot-neutral" : "";
      return `<span class="dot ${css}" title="Ronda ${i+1}: ${action || "sin jugar"}"></span>`;
    }).join("");
    if (playerDots) playerDots.innerHTML = `<span style="color:#f04be8;font-size:11px;width:100%">PLAYER 1 · COOPERACIÓN / TRAICIÓN / NEUTRAL / NO DECISORIA</span>` + renderDots(state.history || [], "player_state");
    if (botDots) botDots.innerHTML = `<span style="color:#47f3ff;font-size:11px;width:100%">Q-BOT · COOPERACIÓN / TRAICIÓN / NEUTRAL / NO DECISORIA</span>` + renderDots(state.history || [], "machine_state");

    document.querySelectorAll("[data-m]").forEach(button => {
      button.disabled = Boolean(state.game_over) || roundSubmissionBusy;
    });
    if (state.game_over) showFinalGuess(state);
    else if ($("qaPersonalityGuessPanel")) $("qaPersonalityGuessPanel").hidden = true;
  }

  function switchScreenLocally(id) {
    document.querySelectorAll(".screen").forEach(screen => screen.classList.remove("active"));
    $(id)?.classList.add("active");
    window.scrollTo(0, 0);
  }

  function unlockRoundAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!roundAudioContext) roundAudioContext = new AudioContextClass();
    if (roundAudioContext.state === "suspended") roundAudioContext.resume().catch(() => {});
  }

  function playRoundSound() {
    unlockRoundAudio();
    const ctx = roundAudioContext;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(740, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.085);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.12);
  }

  async function apiPost(path, payload = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function startNewGame() {
    unlockRoundAudio();
    roundSubmissionBusy = false;
    try {
      const response = await apiPost("/api/game/reset");
      renderGameState(response.state);
      switchScreenLocally("game");
      if ($("qaRoundResult")) $("qaRoundResult").textContent = "Partida nueva: observa el acuerdo y elige tu símbolo.";
      statusText("Motor cuántico local listo · personalidad secreta seleccionada.");
    } catch (error) {
      statusText(`No se pudo iniciar el motor cuántico: ${error.message}. Mantén Python ejecutándose.`);
      alert(`No se pudo iniciar la partida cuántica.\n${error.message}\n\nEjecuta quantum_arcade_main.py y abre el juego desde localhost.`);
    }
  }

  async function resetToIntro() {
    roundSubmissionBusy = false;
    requestCameraState(false);
    try {
      const response = await apiPost("/api/game/reset");
      renderGameState(response.state);
    } catch (_error) { /* El siguiente START intentará inicializar otra partida. */ }
    switchScreenLocally("intro");
  }

  async function submitMove(move, source = "buttons") {
    if (!SYMBOL[{rock:"piedra",paper:"papel",scissors:"tijeras"}[move]] || roundSubmissionBusy) return;
    if (!$("game")?.classList.contains("active")) return;
    if (currentGameState?.game_over) return;

    roundSubmissionBusy = true;
    document.querySelectorAll("[data-m]").forEach(button => { button.disabled = true; });
    if ($("botstate")) $("botstate").textContent = "Q-BOT THINKING / QUANTUM MEASUREMENT...";
    if ($("qaRoundResult")) $("qaRoundResult").textContent = source === "camera" ? "GESTO CONFIRMADO · MIDIENDO Q-BOT..." : "JUGADA CONFIRMADA · MIDIENDO Q-BOT...";
    try {
      const response = await apiPost("/api/round", { player_move: move });
      playRoundSound();
      renderGameState(response.state);
      const r = response.record;
      if ($("qaRoundResult")) {
        const winner = r.winner === "Gana jugador" ? "PLAYER 1 GANA ESTA RONDA" : r.winner === "Gana máquina" ? "Q-BOT GANA ESTA RONDA" : "RONDA EMPATADA";
        $("qaRoundResult").textContent = `${winner} · +${r.player_points} P1 / +${r.machine_points} Q-BOT`;
      }
      if (response.state.game_over) switchScreenLocally("ending");
    } catch (error) {
      statusText(`No se pudo resolver la ronda: ${error.message}`);
      if ($("qaRoundResult")) $("qaRoundResult").textContent = `ERROR DE RONDA: ${error.message}`;
      if (currentGameState) renderGameState(currentGameState);
    } finally {
      roundSubmissionBusy = false;
      if (currentGameState) renderGameState(currentGameState);
    }
  }

  function showFinalGuess(state) {
    const panel = $("qaPersonalityGuessPanel");
    if (!panel) return;
    panel.hidden = false;
    const result = $("qaGuessResult");
    const buttons = panel.querySelectorAll("[data-personality]");
    if (state.guess_submitted) {
      buttons.forEach(button => { button.disabled = true; });
      const right = Boolean(state.guess_correct);
      if (result) result.textContent = `${right ? "¡ACERTASTE! +15 PUNTOS." : "NO ACERTASTE."} Personalidad real: ${PERSONALITY_LABELS[state.personality] || state.personality}.`;
      const title = $("endtitle");
      if (title) title.innerHTML = state.scores.player > state.scores.machine ? "CONGRATULATIONS!<br>YOU WIN!" : state.scores.player < state.scores.machine ? "BETTER LUCK<br>NEXT TIME" : "IT'S A TIE!<br>GOOD GAME!";
      if ($("endscore")) $("endscore").innerHTML = `PLAYER 1: ${state.scores.player} PTS<br>Q-BOT: ${state.scores.machine} PTS<br><small>${state.rounds_completed} ROUNDS COMPLETE</small>`;
    } else {
      buttons.forEach(button => { button.disabled = false; });
      if (result) result.textContent = "La personalidad es secreta. Acierta para ganar 15 puntos extra.";
      if ($("endtitle")) $("endtitle").innerHTML = "15 ROUNDS COMPLETE<br>GUESS Q-BOT!";
      if ($("endscore")) $("endscore").innerHTML = `PLAYER 1: ${state.scores.player} PTS<br>Q-BOT: ${state.scores.machine} PTS<br><small>ADIVINA LA PERSONALIDAD PARA EL BONO FINAL</small>`;
    }
  }

  async function submitPersonalityGuess(guess) {
    const panel = $("qaPersonalityGuessPanel");
    if (!panel || currentGameState?.guess_submitted) return;
    panel.querySelectorAll("[data-personality]").forEach(button => { button.disabled = true; });
    try {
      const response = await apiPost("/api/guess-personality", { guess });
      renderGameState(response.state);
      showFinalGuess(response.state);
    } catch (error) {
      panel.querySelectorAll("[data-personality]").forEach(button => { button.disabled = false; });
      const result = $("qaGuessResult");
      if (result) result.textContent = `No se pudo registrar la respuesta: ${error.message}`;
    }
  }

  function installGameControls() {
    // Captura los clics antes que los listeners del juego clásico, para no ejecutar
    // la vieja puntuación W/L/D en paralelo a las reglas nuevas.
    document.addEventListener("click", event => {
      const target = event.target instanceof Element
        ? event.target.closest("#start, #restart, #end, [data-m], [data-personality]")
        : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (target.id === "start") {
        startNewGame();
      } else if (target.id === "restart") {
        resetToIntro();
      } else if (target.id === "end") {
        if (!currentGameState?.game_over) {
          if ($("qaRoundResult")) $("qaRoundResult").textContent = "Completa las 15 rondas para revelar la personalidad de Q-BOT.";
        } else {
          switchScreenLocally("ending");
        }
      } else if (target.hasAttribute("data-m")) {
        submitMove(target.dataset.m, "buttons");
      } else if (target.hasAttribute("data-personality")) {
        submitPersonalityGuess(target.dataset.personality);
      }
    }, true);
  }

  function install() {
    installStyles();
    installPlayerCamera();
    installLabModal();
    installAgreementPanel();
    installIntroRules();
    installPersonalityGuessPanel();
    installGameControls();

    // Intercepta en fase de captura el listener antiguo que abría otra webcam en el navegador.
    // La única cámara será la que usa Python/OpenCV para la inferencia.
    document.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target.closest("#cameraToggle") : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      requestCameraState(!cameraEnabled);
    }, true);

    setCameraUi();
    pollPythonState();
    fetch(`${API_BASE}/api/game-state`, { cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("game state unavailable")))
      .then(state => { if (state.ok !== false) renderGameState(state); })
      .catch(() => { if ($("qaRoundResult")) $("qaRoundResult").textContent = "Inicia Python para activar la máquina cuántica; los controles visuales seguirán disponibles."; });
    window.setInterval(pollPythonState, 100);
    frameTimer = window.setInterval(refreshCameraFrame, 100);

    // Conserva los botones manuales como alternativa permanente.
    document.querySelectorAll("[data-m]").forEach(button => {
      button.disabled = false;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
