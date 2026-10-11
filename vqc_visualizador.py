"""Puente local entre el VQC de Qiskit y el explorador educativo HTML.

No abre una ventana OpenCV. Publica el circuito y el estado de inferencia en
http://127.0.0.1:8765 para que el videojuego HTML lo muestre dentro de un modal.

Uso básico:
    from vqc_visualizador import VQCVisualizer
    visualizador = VQCVisualizer(vqc)

    # Dentro del bucle de la webcam, tras calcular la predicción:
    visualizador.actualizar(
        angulos,
        etiqueta,  # gesto estable (o ESTABILIZANDO...)
        mano_detectada=True,
        prediccion_instantanea=NOMBRES_CLASES[clase],
        votos_por_clase={
            "PIEDRA": conteo.get(0, 0),
            "PAPEL": conteo.get(1, 0),
            "TIJERA": conteo.get(2, 0),
        },
        votos_coincidentes=votos,
    )

    # Al finalizar:
    visualizador.cerrar()

El servidor escucha solo en localhost; no se expone a la red local.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit

import numpy as np
import cv2


BASE_DIR = Path(__file__).resolve().parent
HTML_FILE = BASE_DIR / "vqc_explorador.html"
GAME_HTML_FILE = BASE_DIR / "quantum_arcade.html"
GAME_JS_FILE = BASE_DIR / "quantum_arcade_vqc.js"
_CLASS_NAMES = ("PIEDRA", "PAPEL", "TIJERA")


class _ReusableThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class VQCVisualizer:
    """Sirve el explorador HTML y le publica metadatos del VQC e inferencias."""

    def __init__(
        self,
        vqc: Any,
        *,
        host: str = "127.0.0.1",
        port: int = 8765,
        html_path: str | Path | None = None,
        game_html_path: str | Path | None = None,
        game_js_path: str | Path | None = None,
        game_engine: Any | None = None,
    ) -> None:
        self.host = host
        self.html_path = Path(html_path).resolve() if html_path else HTML_FILE
        self.game_html_path = Path(game_html_path).resolve() if game_html_path else GAME_HTML_FILE
        self.game_js_path = Path(game_js_path).resolve() if game_js_path else GAME_JS_FILE
        self.game_engine = game_engine
        self._lock = threading.Lock()
        self._camera_available = False
        self._camera_enabled = False
        self._latest_jpeg: bytes | None = None
        self._frame_version = 0
        self._gesture_event_id = 0
        self._gesture_event: str | None = None
        self._model = self._build_model_payload(vqc)
        self._live: dict[str, Any] = {
            "hand_detected": False,
            "angles": None,
            "stable_label": None,
            "instant_label": None,
            "status_label": "ESPERANDO MANO",
            "votes_by_class": {name: 0 for name in _CLASS_NAMES},
            "matching_votes": None,
            "probabilities": None,
            "latency_ms": None,
            "updated_at": time.time(),
            "camera_available": False,
            "camera_enabled": False,
            "gesture_event_id": 0,
            "gesture_event": None,
        }
        self._server: _ReusableThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

        if not self.html_path.is_file():
            raise FileNotFoundError(
                "No se encontró la interfaz web del visualizador:\n"
                f"{self.html_path}\n"
                "Coloca vqc_explorador.html junto a vqc_visualizador.py."
            )

        # El HTML del videojuego apunta deliberadamente a localhost:8765.
        # Usar un puerto fijo evita que el iframe termine apuntando a un puerto
        # diferente si hay otro servicio ocupando el predeterminado.
        self.port = int(port)
        try:
            self._server = _ReusableThreadingHTTPServer(
                (self.host, self.port), self._make_handler()
            )
        except OSError as exc:
            raise RuntimeError(
                f"No se pudo iniciar el visualizador en {self.host}:{self.port}. "
                "Cierra el proceso que esté usando ese puerto e inténtalo de nuevo."
            ) from exc

        self.url = f"http://{self.host}:{self.port}/"
        self.embed_url = f"http://{self.host}:{self.port}/embed"
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="VQCVisualizerHTTP",
            daemon=True,
        )
        self._thread.start()
        self.game_url = f"http://{self.host}:{self.port}/game"
        print(f"Videojuego local: {self.game_url}")
        print(f"Explorador educativo del VQC: {self.url}")
        print(f"URL para incrustar en un iframe: {self.embed_url}")

    @staticmethod
    def _get_attr(obj: Any, name: str, default: Any = None) -> Any:
        try:
            value = getattr(obj, name, default)
            return default if value is None else value
        except Exception:
            return default

    @classmethod
    def _extract_circuit(cls, circuit: Any, display_name: str) -> dict[str, Any]:
        if circuit is None:
            return {
                "name": display_name,
                "num_qubits": 0,
                "num_parameters": 0,
                "operations": [],
                "operation_count": 0,
                "available": False,
            }

        try:
            num_qubits = int(getattr(circuit, "num_qubits", 0))
        except Exception:
            num_qubits = 0
        try:
            num_parameters = int(getattr(circuit, "num_parameters", 0))
        except Exception:
            num_parameters = 0

        operations: list[dict[str, Any]] = []
        for instruction in getattr(circuit, "data", []):
            try:
                operation = instruction.operation
                qubits = instruction.qubits
            except Exception:
                try:
                    operation, qubits, _ = instruction
                except Exception:
                    continue

            name = str(getattr(operation, "name", "op")).lower()
            if name in {"barrier", "delay"}:
                continue
            try:
                q_indices = [int(circuit.find_bit(q).index) for q in qubits]
            except Exception:
                q_indices = []
            if any(q < 0 or q >= num_qubits for q in q_indices):
                continue
            try:
                params = [str(p) for p in getattr(operation, "params", ())]
            except Exception:
                params = []
            operations.append({
                "name": name,
                "qubits": q_indices,
                "params": params,
                "column": 0,
            })

        # Asigna columnas de circuito: puertas independientes pueden compartir una.
        last_column = [-1] * max(1, num_qubits)
        max_column = -1
        for operation in operations:
            qargs = operation["qubits"]
            if qargs:
                column = max(last_column[q] for q in qargs) + 1
                for q in qargs:
                    last_column[q] = column
            else:
                column = max_column + 1
            max_column = max(max_column, column)
            operation["column"] = column

        return {
            "name": str(getattr(circuit, "name", display_name) or display_name),
            "num_qubits": num_qubits,
            "num_parameters": num_parameters,
            "operations": operations,
            "operation_count": len(operations),
            "available": True,
        }

    @classmethod
    def _build_model_payload(cls, vqc: Any) -> dict[str, Any]:
        feature_map = cls._get_attr(vqc, "feature_map")
        ansatz = cls._get_attr(vqc, "ansatz")
        feature = cls._extract_circuit(feature_map, "Mapa de características")
        variational = cls._extract_circuit(ansatz, "Ansatz variacional")

        inferred_qubits = max(
            feature.get("num_qubits", 0), variational.get("num_qubits", 0),
            int(cls._get_attr(vqc, "num_qubits", 0) or 0),
        )
        try:
            output_shape = int(cls._get_attr(vqc, "output_shape", 3) or 3)
        except Exception:
            output_shape = 3

        weights = cls._get_attr(vqc, "weights")
        if weights is None:
            fit_result = cls._get_attr(vqc, "_fit_result")
            weights = cls._get_attr(fit_result, "x") if fit_result is not None else None
        weight_values: list[float] | None = None
        if weights is not None:
            try:
                arr = np.asarray(weights, dtype=float).reshape(-1)
                if arr.size and np.isfinite(arr).all():
                    # En la práctica el ansatz suele tener pocos parámetros; limita por seguridad.
                    weight_values = [float(v) for v in arr[:128]]
            except (TypeError, ValueError):
                weight_values = None

        sampler = cls._get_attr(vqc, "sampler")
        sampler_name = type(sampler).__name__ if sampler is not None else "No expuesto por la versión instalada"

        return {
            "title": "Laboratorio interactivo de un VQC",
            "num_qubits": inferred_qubits,
            "output_shape": output_shape,
            "feature_map": feature,
            "ansatz": variational,
            "weights": weight_values,
            "weight_count": len(weight_values) if weight_values is not None else None,
            "sampler_name": sampler_name,
            "label_mapping": [
                {"index": 0, "label": "PIEDRA"},
                {"index": 1, "label": "PAPEL"},
                {"index": 2, "label": "TIJERA"},
            ],
            "interpret_rule": "indice % 3",
            "source_note": "Circuitos leídos desde el objeto VQC cargado en Python.",
        }

    def _make_handler(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def _headers(self, status: int, content_type: str, content_length: int) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(content_length))
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_OPTIONS(self) -> None:  # noqa: N802
                self._headers(204, "text/plain; charset=utf-8", 0)

            def do_GET(self) -> None:  # noqa: N802
                path = urlsplit(self.path).path
                if path == "/api/model":
                    with owner._lock:
                        body = json.dumps(owner._model, ensure_ascii=False).encode("utf-8")
                    self._headers(200, "application/json; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                if path == "/api/state":
                    with owner._lock:
                        body = json.dumps(owner._live, ensure_ascii=False).encode("utf-8")
                    self._headers(200, "application/json; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                if path == "/api/game-state":
                    if owner.game_engine is None:
                        payload = {"ok": False, "error": "Motor de la partida no inicializado"}
                        status = 503
                    else:
                        payload = owner.game_engine.state()
                        status = 200
                    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                    self._headers(status, "application/json; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                if path == "/api/health":
                    with owner._lock:
                        payload = {
                            "ok": True,
                            "camera_available": owner._camera_available,
                            "camera_enabled": owner._camera_enabled,
                            "game_html_exists": owner.game_html_path.is_file(),
                            "game_engine_available": owner.game_engine is not None,
                        }
                    body = json.dumps(payload).encode("utf-8")
                    self._headers(200, "application/json; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                if path == "/game":
                    if not owner.game_html_path.is_file():
                        body = (
                            "No se encontró quantum_arcade.html junto a vqc_visualizador.py. "
                            "Guarda tu interfaz del juego con ese nombre en la carpeta del proyecto."
                        ).encode("utf-8")
                        self._headers(404, "text/plain; charset=utf-8", len(body))
                        self.wfile.write(body)
                        return
                    body = owner.game_html_path.read_bytes()
                    self._headers(200, "text/html; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                if path == "/quantum_arcade_vqc.js":
                    if not owner.game_js_path.is_file():
                        body = b"No se encontro quantum_arcade_vqc.js"
                        self._headers(404, "text/plain; charset=utf-8", len(body))
                        self.wfile.write(body)
                        return
                    body = owner.game_js_path.read_bytes()
                    self._headers(200, "text/javascript; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                if path == "/camera.mjpg":
                    # Un único flujo MJPEG evita volver a solicitar un JPEG cada 180 ms.
                    # Solo se transmite el fotograma más reciente; no se acumula una cola.
                    self.send_response(200)
                    self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                    self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                    self.send_header("Pragma", "no-cache")
                    self.end_headers()
                    last_version = -1
                    try:
                        while True:
                            with owner._lock:
                                active = owner._camera_enabled and owner._camera_available
                                jpeg = owner._latest_jpeg
                                version = owner._frame_version
                            if not active:
                                break
                            if jpeg is not None and version != last_version:
                                chunk = (
                                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                    + str(len(jpeg)).encode("ascii")
                                    + b"\r\n\r\n" + jpeg + b"\r\n"
                                )
                                self.wfile.write(chunk)
                                self.wfile.flush()
                                last_version = version
                            time.sleep(0.01)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                        pass
                    return

                if path == "/camera.jpg":
                    # Endpoint de compatibilidad para pruebas manuales.
                    with owner._lock:
                        jpeg = owner._latest_jpeg if owner._camera_enabled and owner._camera_available else None
                    if jpeg is None:
                        body = b"Camara apagada o sin fotograma disponible"
                        self._headers(503, "text/plain; charset=utf-8", len(body))
                        self.wfile.write(body)
                        return
                    self._headers(200, "image/jpeg", len(jpeg))
                    self.wfile.write(jpeg)
                    return

                if path in {"/", "/embed", "/embed/"}:
                    try:
                        body = owner.html_path.read_bytes()
                    except OSError:
                        body = b"No se pudo leer vqc_explorador.html"
                        self._headers(500, "text/plain; charset=utf-8", len(body))
                        self.wfile.write(body)
                        return
                    self._headers(200, "text/html; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                body = b"Ruta no encontrada"
                self._headers(404, "text/plain; charset=utf-8", len(body))
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                path = urlsplit(self.path).path
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                    if not isinstance(payload, dict):
                        raise ValueError("El cuerpo JSON debe ser un objeto")
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                    body = json.dumps({"ok": False, "error": "JSON inválido"}, ensure_ascii=False).encode("utf-8")
                    self._headers(400, "application/json; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                # API de la modalidad de acuerdos/dilema del prisionero.
                if path in {"/api/game/reset", "/api/round", "/api/guess-personality"}:
                    if owner.game_engine is None:
                        payload_out = {"ok": False, "error": "El motor cuántico de la partida no está inicializado."}
                        status = 503
                    else:
                        try:
                            if path == "/api/game/reset":
                                payload_out = {"ok": True, "state": owner.game_engine.reset()}
                            elif path == "/api/round":
                                if "player_move" not in payload:
                                    raise ValueError("Falta player_move")
                                payload_out = owner.game_engine.play_round(payload["player_move"])
                            else:
                                if "guess" not in payload:
                                    raise ValueError("Falta guess")
                                payload_out = owner.game_engine.guess_personality(payload["guess"])
                            status = 200
                        except ValueError as exc:
                            payload_out = {"ok": False, "error": str(exc)}
                            status = 400
                        except Exception as exc:
                            payload_out = {"ok": False, "error": f"Falló la ejecución del rival cuántico: {exc}"}
                            status = 500
                    body = json.dumps(payload_out, ensure_ascii=False).encode("utf-8")
                    self._headers(status, "application/json; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                if path != "/api/camera/toggle":
                    body = b'{"ok":false,"error":"Ruta no encontrada"}'
                    self._headers(404, "application/json; charset=utf-8", len(body))
                    self.wfile.write(body)
                    return

                enabled = bool(payload.get("enabled", False))
                success = owner._set_camera_enabled(enabled)
                with owner._lock:
                    state = {
                        "ok": success,
                        "camera_available": owner._camera_available,
                        "camera_enabled": owner._camera_enabled,
                        "error": None if success or not enabled else "La cámara de Python no está disponible",
                    }
                body = json.dumps(state, ensure_ascii=False).encode("utf-8")
                self._headers(200 if success else 409, "application/json; charset=utf-8", len(body))
                self.wfile.write(body)

            def log_message(self, _format: str, *_args: Any) -> None:
                # Evita imprimir una línea por cada consulta de la página.
                return

        return Handler

    @staticmethod
    def _normalize_label(value: Any) -> str | None:
        if value is None:
            return None
        normalized = str(value).strip().upper()
        return normalized if normalized in _CLASS_NAMES else None

    @staticmethod
    def _normalize_votes(votes: Any) -> dict[str, int]:
        result = {name: 0 for name in _CLASS_NAMES}
        if not isinstance(votes, dict):
            return result
        for key, value in votes.items():
            key_text = str(key).strip().upper()
            if key_text in _CLASS_NAMES:
                try:
                    result[key_text] = max(0, int(value))
                except (TypeError, ValueError):
                    pass
        return result

    def actualizar(
        self,
        angulos: Iterable[float] | np.ndarray | None,
        etiqueta: str | None,
        *,
        mano_detectada: bool = True,
        prediccion_instantanea: str | None = None,
        votos_por_clase: dict[str, int] | None = None,
        votos_coincidentes: int | None = None,
        probabilidades: Iterable[float] | np.ndarray | None = None,
        latencia_ms: float | None = None,
    ) -> None:
        """Publica los datos reales más recientes para que la interfaz los muestre.

        `etiqueta`: resultado estabilizado del programa principal.
        `prediccion_instantanea`: clase devuelta por predict() en este fotograma.
        `probabilidades`: opcional; envíalas solo si las has calculado realmente.
        No se inventan probabilidades cuando no se proporcionan.
        """
        values: list[float] | None = None
        if angulos is not None:
            try:
                arr = np.asarray(list(angulos), dtype=float).reshape(-1)
                if arr.size >= 5 and np.isfinite(arr[:5]).all():
                    values = [float(v) for v in arr[:5]]
            except (TypeError, ValueError):
                values = None

        probs: list[float] | None = None
        if probabilidades is not None:
            try:
                arr_p = np.asarray(list(probabilidades), dtype=float).reshape(-1)
                if arr_p.size == 3 and np.isfinite(arr_p).all():
                    probs = [float(v) for v in arr_p]
            except (TypeError, ValueError):
                probs = None

        try:
            latency = float(latencia_ms) if latencia_ms is not None else None
            if latency is not None and (not np.isfinite(latency) or latency < 0):
                latency = None
        except (TypeError, ValueError):
            latency = None

        try:
            matching = int(votos_coincidentes) if votos_coincidentes is not None else None
            if matching is not None:
                matching = max(0, matching)
        except (TypeError, ValueError):
            matching = None

        stable_label = self._normalize_label(etiqueta)
        instant_label = self._normalize_label(prediccion_instantanea)
        status_label = str(etiqueta).strip() if etiqueta is not None else "SIN CLASIFICAR"

        live = {
            "hand_detected": bool(mano_detectada),
            "angles": values,
            "stable_label": stable_label,
            "instant_label": instant_label,
            "status_label": status_label,
            "votes_by_class": self._normalize_votes(votos_por_clase),
            "matching_votes": matching,
            "probabilities": probs,
            "latency_ms": latency,
            "updated_at": time.time(),
        }
        if not mano_detectada:
            live.update({
                "angles": None,
                "stable_label": None,
                "instant_label": None,
                "status_label": "NO SE DETECTA MANO",
                "votes_by_class": {name: 0 for name in _CLASS_NAMES},
                "matching_votes": None,
                "probabilities": None,
            })
        with self._lock:
            live.update({
                "camera_available": self._camera_available,
                "camera_enabled": self._camera_enabled,
                "gesture_event_id": self._gesture_event_id,
                "gesture_event": self._gesture_event,
            })
            self._live = live

    @property
    def camera_enabled(self) -> bool:
        with self._lock:
            return self._camera_enabled

    @property
    def camera_available(self) -> bool:
        with self._lock:
            return self._camera_available

    def establecer_camara_disponible(self, disponible: bool) -> None:
        with self._lock:
            self._camera_available = bool(disponible)
            if not self._camera_available:
                self._camera_enabled = False
                self._latest_jpeg = None
            self._live["camera_available"] = self._camera_available
            self._live["camera_enabled"] = self._camera_enabled

    def _set_camera_enabled(self, enabled: bool) -> bool:
        with self._lock:
            if enabled and not self._camera_available:
                return False
            self._camera_enabled = bool(enabled)
            if not self._camera_enabled:
                self._latest_jpeg = None
            self._live["camera_enabled"] = self._camera_enabled
            self._live["camera_available"] = self._camera_available
            return True

    def publicar_frame(self, imagen: np.ndarray) -> None:
        """Guarda el fotograma más reciente para mostrarlo en Player 1 vía HTTP local."""
        try:
            ok, encoded = cv2.imencode(
                ".jpg", imagen, [int(cv2.IMWRITE_JPEG_QUALITY), 72]
            )
            if not ok:
                return
            with self._lock:
                if self._camera_enabled and self._camera_available:
                    self._latest_jpeg = encoded.tobytes()
                    self._frame_version += 1
        except Exception:
            # Un fallo de codificación no debe detener el bucle de inferencia.
            return

    def registrar_gesto(self, etiqueta: str) -> None:
        """Publica una decisión nueva una sola vez; la web consume el ID del evento."""
        labels = {"PIEDRA": "rock", "PAPEL": "paper", "TIJERA": "scissors"}
        move = labels.get(str(etiqueta).strip().upper())
        if move is None:
            return
        with self._lock:
            if not self._camera_available or not self._camera_enabled:
                return
            self._gesture_event_id += 1
            self._gesture_event = move
            self._live["gesture_event_id"] = self._gesture_event_id
            self._live["gesture_event"] = self._gesture_event
            self._live["updated_at"] = time.time()

    def cerrar(self) -> None:
        """Detiene el servidor local cuando termina el juego."""
        server = self._server
        self._server = None
        if server is not None:
            server.shutdown()
            server.server_close()
        self._thread = None


__all__ = ["VQCVisualizer"]
