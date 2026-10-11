"""Quantum Arcade + inferencia local del VQC.

Guarda este archivo junto a:
- vqc_visualizador.py
- vqc_explorador.html
- quantum_arcade_vqc.js
- quantum_prisoners_dilemma.py (motor del rival cuántico y los acuerdos)
- quantum_arcade.html (la interfaz HTML del juego)
- vqc_piedra_papel_tijera_seed_0.dill
- hand_landmarker.task

Inicia con: python quantum_arcade_main.py
Luego abre la URL /game que se imprime en la terminal.
La cámara solo se procesa cuando se pulsa CAMERA: ON dentro del videojuego.
Si no se puede abrir la webcam, el servidor permanece activo y se puede jugar
con los botones manuales.
"""
from __future__ import annotations

from collections import Counter, deque
from pathlib import Path
import threading
import time

import cv2
import mediapipe as mp
import numpy as np
from qiskit_machine_learning.algorithms import VQC

from vqc_visualizador import VQCVisualizer
from quantum_prisoners_dilemma import QuantumPrisonersDilemma


CARPETA = Path(__file__).resolve().parent
RUTA_VQC = CARPETA / "vqc_piedra_papel_tijera_seed_0.dill"
RUTA_MODELO_MANO = CARPETA / "hand_landmarker.task"
RUTA_JUEGO = CARPETA / "quantum_arcade.html"
RUTA_LAB = CARPETA / "vqc_explorador.html"
RUTA_INTEGRADOR = CARPETA / "quantum_arcade_vqc.js"
RUTA_MOTOR_JUEGO = CARPETA / "quantum_prisoners_dilemma.py"

NOMBRES_CLASES = {0: "PIEDRA", 1: "PAPEL", 2: "TIJERA"}
PUNTOS_ANGULO = {
    "pulgar": (1, 2, 3),
    "indice": (5, 6, 7),
    "medio": (9, 10, 11),
    "anular": (13, 14, 15),
    "menique": (17, 18, 19),
}


def calcular_angulo(p1, p2, p3):
    """Ángulo interior 3D en radianes, igual que el script de recolección."""
    a = np.array([p1.x, p1.y, p1.z], dtype=float)
    b = np.array([p2.x, p2.y, p2.z], dtype=float)
    c = np.array([p3.x, p3.y, p3.z], dtype=float)
    va, vc = a - b, c - b
    denominador = np.linalg.norm(va) * np.linalg.norm(vc)
    if denominador < 1e-9:
        return 0.0
    coseno = np.clip(np.dot(va, vc) / denominador, -1.0, 1.0)
    return float(np.arccos(coseno))


def extraer_caracteristicas(landmarks):
    """Cinco ángulos en el orden usado para entrenar el VQC."""
    valores = []
    for nombre in ("pulgar", "indice", "medio", "anular", "menique"):
        i1, i2, i3 = PUNTOS_ANGULO[nombre]
        valores.append(calcular_angulo(landmarks[i1], landmarks[i2], landmarks[i3]))
    vector = np.asarray(valores, dtype=float)
    if vector.shape != (5,) or not np.isfinite(vector).all():
        raise ValueError("Las cinco características calculadas no son válidas.")
    return vector


def predecir_clase(modelo, caracteristicas):
    salida = np.asarray(modelo.predict(np.asarray(caracteristicas).reshape(1, 5))).reshape(-1)
    if salida.size != 1:
        raise ValueError(f"Salida inesperada del VQC: forma {salida.shape}")
    clase = int(salida[0])
    if clase not in NOMBRES_CLASES:
        raise ValueError(f"Clase desconocida devuelta por VQC: {clase}")
    return clase


def crear_reconocedor(ruta_modelo: Path):
    BaseOptions = mp.tasks.BaseOptions
    HandLandmarker = mp.tasks.vision.HandLandmarker
    HandLandmarkerOptions = mp.tasks.vision.HandLandmarkerOptions
    RunningMode = mp.tasks.vision.RunningMode
    opciones = HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(ruta_modelo)),
        running_mode=RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return HandLandmarker.create_from_options(opciones)



class CapturaContinua:
    """Lee la webcam en un hilo para que el modelo nunca acumule fotogramas viejos."""

    def __init__(self, camara, visualizador):
        self.camara = camara
        self.visualizador = visualizador
        self._lock = threading.Lock()
        self._ultimo_fotograma = None
        self._numero_fotograma = 0
        self._fallos_lectura = 0
        self._activo = threading.Event()
        self._activo.set()
        self._hilo = threading.Thread(
            target=self._bucle, name="WebcamLatestFrame", daemon=True
        )
        self._hilo.start()

    def _bucle(self):
        while self._activo.is_set():
            correcto, imagen = self.camara.read()
            if not correcto:
                with self._lock:
                    self._fallos_lectura += 1
                time.sleep(0.005)
                continue

            # Mantiene el efecto espejo y guarda solo el fotograma más reciente.
            imagen = cv2.flip(imagen, 1)
            with self._lock:
                self._ultimo_fotograma = imagen
                self._numero_fotograma += 1
                self._fallos_lectura = 0

            # El vídeo se publica independientemente de la inferencia del VQC.
            # Así la interfaz sigue fluida aunque el clasificador tarde más.
            if self.visualizador.camera_enabled:
                self.visualizador.publicar_frame(imagen)

    def obtener_ultimo(self):
        with self._lock:
            if self._ultimo_fotograma is None:
                return self._numero_fotograma, None
            return self._numero_fotograma, self._ultimo_fotograma.copy()

    @property
    def fallos_lectura(self):
        with self._lock:
            return self._fallos_lectura

    def detener(self):
        self._activo.clear()
        self._hilo.join(timeout=0.5)


def main():
    for ruta, descripcion in (
        (RUTA_VQC, "modelo VQC .dill"),
        (RUTA_MODELO_MANO, "modelo de MediaPipe hand_landmarker.task"),
        (RUTA_LAB, "vqc_explorador.html"),
        (RUTA_INTEGRADOR, "quantum_arcade_vqc.js"),
        (RUTA_MOTOR_JUEGO, "quantum_prisoners_dilemma.py"),
        (RUTA_JUEGO, "quantum_arcade.html"),
    ):
        if not ruta.is_file():
            raise FileNotFoundError(
                f"Falta {descripcion}:\n{ruta}\n\n"
                "Coloca el archivo junto a quantum_arcade_main.py. "
                "Guarda la interfaz que compartiste con el nombre quantum_arcade.html."
            )

    print("Cargando VQC entrenado...")
    vqc = VQC.from_dill(str(RUTA_VQC))
    # El motor mantiene personalidad secreta, probabilidades y puntuación durante 15 rondas.
    motor_partida = QuantumPrisonersDilemma(total_rounds=15)
    visualizador = VQCVisualizer(
        vqc,
        html_path=RUTA_LAB,
        game_html_path=RUTA_JUEGO,
        game_js_path=RUTA_INTEGRADOR,
        game_engine=motor_partida,
    )

    camara = None
    reconocedor = None
    captura = None
    try:
        # Menor resolución + buffer corto reducen la latencia de captura.
        # En Windows se prueba primero DirectShow; si falla, se usa el backend por defecto.
        camara = cv2.VideoCapture(0, cv2.CAP_DSHOW)
        if not camara.isOpened():
            camara.release()
            camara = cv2.VideoCapture(0)
        camara.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        camara.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        camara.set(cv2.CAP_PROP_FPS, 30)
        camara.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        camara_disponible = camara.isOpened()
        visualizador.establecer_camara_disponible(camara_disponible)

        if not camara_disponible:
            print("ADVERTENCIA: no se pudo abrir la webcam.")
            print("El videojuego y VQC LAB siguen disponibles; usa los botones manuales.")
            print("Cierra otra aplicación que use la cámara y reinicia este script para probarla.")
            while True:
                time.sleep(1)

        reconocedor = crear_reconocedor(RUTA_MODELO_MANO)
        captura = CapturaContinua(camara, visualizador)
        print("Webcam disponible. Actívala con CAMERA: ON dentro del juego.")
        print("Resolución objetivo: 640x480; captura desacoplada del VQC.")
        print("Motor del dilema del prisionero cuántico preparado: 15 rondas por partida.")
        print("Para detener este programa, pulsa Ctrl+C en esta terminal.")

        marca_inicio = time.monotonic()
        marca_tiempo_ms = 0
        historial_clases = deque(maxlen=9)
        gesto_armado = True
        fotogramas_sin_mano = 0
        ultimo_fotograma_procesado = -1
        while True:
            if not camara.isOpened():
                visualizador.establecer_camara_disponible(False)
                time.sleep(0.2)
                continue

            numero_fotograma, imagen = captura.obtener_ultimo()
            if imagen is None or numero_fotograma == ultimo_fotograma_procesado:
                if captura.fallos_lectura >= 30:
                    print("La webcam dejó de entregar fotogramas; queda disponible el modo manual.")
                    visualizador.establecer_camara_disponible(False)
                    camara.release()
                time.sleep(0.002)
                continue
            ultimo_fotograma_procesado = numero_fotograma

            # El hilo de captura mantiene el espejo y publica el vídeo por separado.
            # La inferencia procesa siempre el fotograma más reciente, no una cola atrasada.
            if not visualizador.camera_enabled:
                historial_clases.clear()
                gesto_armado = True
                fotogramas_sin_mano = 0
                visualizador.actualizar(
                    None, "CÁMARA APAGADA", mano_detectada=False,
                    prediccion_instantanea=None, votos_por_clase=None,
                    votos_coincidentes=None, latencia_ms=None,
                )
                time.sleep(0.01)
                continue

            alto, ancho = imagen.shape[:2]
            imagen_rgb = cv2.cvtColor(imagen, cv2.COLOR_BGR2RGB)
            entrada = mp.Image(image_format=mp.ImageFormat.SRGB, data=imagen_rgb)
            marca_tiempo_ms = max(
                marca_tiempo_ms + 1,
                int((time.monotonic() - marca_inicio) * 1000),
            )
            resultado = reconocedor.detect_for_video(entrada, marca_tiempo_ms)

            angulos = None
            clase_instantanea = None
            conteo = Counter()
            votos_coincidentes = None
            latencia_ms = None
            etiqueta = "NO SE DETECTA MANO"
            mano_detectada = bool(resultado.hand_landmarks)
            evento_nuevo = False

            if mano_detectada:
                fotogramas_sin_mano = 0
                landmarks = resultado.hand_landmarks[0]
                try:
                    angulos = extraer_caracteristicas(landmarks)
                    inicio = time.perf_counter()
                    clase_instantanea = predecir_clase(vqc, angulos)
                    latencia_ms = (time.perf_counter() - inicio) * 1000.0
                    historial_clases.append(clase_instantanea)
                    conteo = Counter(historial_clases)
                    clase_estable, votos_coincidentes = conteo.most_common(1)[0]

                    if votos_coincidentes >= 5:
                        etiqueta = NOMBRES_CLASES[clase_estable]
                        # Un evento, no una jugada por cada fotograma. Para la ronda
                        # siguiente, el jugador retira la mano unos instantes y la vuelve
                        # a presentar; así se pueden repetir incluso gestos iguales.
                        if gesto_armado:
                            visualizador.registrar_gesto(etiqueta)
                            gesto_armado = False
                            evento_nuevo = True
                            print(f"GESTO REGISTRADO: {etiqueta}")
                    else:
                        etiqueta = "ESTABILIZANDO..."
                except Exception as exc:
                    historial_clases.clear()
                    conteo = Counter()
                    votos_coincidentes = None
                    etiqueta = "ERROR AL CLASIFICAR"
                    print(f"Error al clasificar: {exc}")
            else:
                historial_clases.clear()
                fotogramas_sin_mano += 1
                if fotogramas_sin_mano >= 8:
                    gesto_armado = True

            color = (0, 255, 0) if etiqueta in NOMBRES_CLASES.values() else (0, 165, 255)
            cv2.putText(imagen, f"VQC: {etiqueta}", (10, 25), cv2.FONT_HERSHEY_SIMPLEX,
                        0.65, color, 2, cv2.LINE_AA)
            cv2.putText(imagen, "PLAYER 1 - CAMARA LOCAL", (10, alto - 12),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.48, (71, 243, 255), 1, cv2.LINE_AA)
            if evento_nuevo:
                cv2.putText(imagen, "MOVE REGISTERED", (10, 55), cv2.FONT_HERSHEY_SIMPLEX,
                            0.58, (240, 75, 232), 2, cv2.LINE_AA)

            visualizador.actualizar(
                angulos,
                etiqueta,
                mano_detectada=mano_detectada,
                prediccion_instantanea=(
                    NOMBRES_CLASES[clase_instantanea]
                    if clase_instantanea is not None else None
                ),
                votos_por_clase={
                    "PIEDRA": conteo.get(0, 0),
                    "PAPEL": conteo.get(1, 0),
                    "TIJERA": conteo.get(2, 0),
                },
                votos_coincidentes=votos_coincidentes,
                latencia_ms=latencia_ms,
            )
            # El hilo de captura publica el vídeo por su cuenta; no bloquearlo aquí.
            time.sleep(0.001)

    except KeyboardInterrupt:
        print("Cerrando Quantum Arcade...")
    finally:
        if captura is not None:
            captura.detener()
        if reconocedor is not None:
            reconocedor.close()
        if camara is not None:
            camara.release()
        visualizador.cerrar()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
