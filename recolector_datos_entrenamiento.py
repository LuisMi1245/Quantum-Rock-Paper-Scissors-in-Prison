
from pathlib import Path
from urllib.request import urlretrieve
import time
import csv
import cv2 # oPenCV para capturar la cámara y mostrar la imagen
import mediapipe as mp
import numpy as np

# Archivo CSV en la carpeta del proyecto
RUTA_CSV = Path(__file__).resolve().parent / "gestos_test_3.csv"

# Comprobar si el archivo es nuevo o está vacío
archivo_nuevo = (
    not RUTA_CSV.exists()
    or RUTA_CSV.stat().st_size == 0
)

# Abrir el archivo en modo anexado
archivo_csv = RUTA_CSV.open(
    "a",
    newline="",
    encoding="utf-8",
)

# Crear el escritor CSV
escritor = csv.writer(archivo_csv)

# Escribir la cabecera solamente si el archivo está vacío
if archivo_nuevo:
    escritor.writerow([
        "pulgar",
        "indice",
        "medio",
        "anular",
        "menique",
        "label",
    ])
    archivo_csv.flush()

# Calcular el ángulo entre tres puntos 3D
def calcular_angulo(a, b, c):
    """
    Calcula el ángulo ABC en radianes.
    a, b y c son puntos con coordenadas x, y, z.
    """
    # Vectores AB y CB
    va = np.array([a.x - b.x, a.y - b.y, a.z - b.z])
    vc = np.array([c.x - b.x, c.y - b.y, c.z - b.z])

    # Denominador de la fórmula del coseno
    denominador = np.linalg.norm(va) * np.linalg.norm(vc)

    if denominador < 1e-9:
        return 0.0

    # Calcular el coseno del ángulo usando el producto punto
    coseno = np.dot(va, vc) / denominador
    # Asegurarse de que el valor esté en el rango [-1, 1] para evitar errores numéricos
    coseno = np.clip(coseno, -1.0, 1.0) 

    # Devolver el ángulo en radianes
    return float(np.arccos(coseno))


def extraer_caracteristicas(puntos):
    # Definir las articulaciones de la mano para calcular los ángulos
    articulaciones = [
        (1, 2, 3),       # Pulgar
        (5, 6, 7),       # Indice
        (9, 10, 11),     # Medio
        (13, 14, 15),    # Anular
        (17, 18, 19),    # Menique
    ]

    # Se calculan los ángulos para cada articulación y devolverlos como una lista
    # Es decir, se retorna una lista de 5 ángulos, uno por cada dedo.
    # Solamente se calculan los ángulos de las articulaciones principales de cada dedo. 
    # Los puntos de la palma (0, 4, 8, 12, 16, 20) no se utilizan para calcular ángulos.

    return [calcular_angulo(puntos[a], puntos[b], puntos[c]) for a, b, c in articulaciones]


# Configuración de MediaPipe
BaseOptions = mp.tasks.BaseOptions
HandLandmarker = mp.tasks.vision.HandLandmarker
HandLandmarkerOptions = mp.tasks.vision.HandLandmarkerOptions
RunningMode = mp.tasks.vision.RunningMode

opciones = HandLandmarkerOptions(
    base_options=BaseOptions(
        model_asset_path="hand_landmarker.task"
    ),
    running_mode=RunningMode.VIDEO,
    num_hands=1,
)

# Detector de manos
detector = HandLandmarker.create_from_options(opciones)

# Abrir la cámara y reconocer los gestos
camara = cv2.VideoCapture(0)

try:
    if not camara.isOpened():
        raise RuntimeError(
            "No se pudo abrir la cámara. "
            "Comprueba que esté conectada y disponible."
        )

    marca_inicio = time.monotonic()
    marca_tiempo_ms = 0

    ETIQUETAS = {
    ord("1"): "piedra",
    ord("2"): "papel",
    ord("3"): "tijera",
    
    }
    while True:
        correcto, imagen = camara.read()

        if not correcto:
            print("No se pudo leer un fotograma de la cámara.")
            break

        # Efecto espejo para que el movimiento resulte natural.
        imagen = cv2.flip(imagen, 1)

        alto, ancho = imagen.shape[:2]

        # OpenCV entrega BGR; MediaPipe necesita RGB.
        imagen_rgb = cv2.cvtColor(
            imagen, cv2.COLOR_BGR2RGB
        )

        imagen_mediapipe = mp.Image(
            image_format=mp.ImageFormat.SRGB,
            data=imagen_rgb,
        )

        # MediaPipe requiere marcas de tiempo crecientes.
        marca_tiempo_ms = max(
            marca_tiempo_ms + 1,
            int((time.monotonic() - marca_inicio) * 1000),
        )

        resultado = detector.detect_for_video(
            imagen_mediapipe,
            marca_tiempo_ms,
    
        )

        # Reiniciar las características en cada fotograma
        caracteristicas = None

        # Detectar la mano y calcular sus ángulos
        if resultado.hand_landmarks:
            puntos = resultado.hand_landmarks[0]
            caracteristicas = extraer_caracteristicas(puntos)
            print(caracteristicas)
        else:
            print("No se detectó ninguna mano")


        # Mostrar la imagen
        cv2.imshow(
            "Ángulos (radianes) - MediaPipe",
            imagen,
        )

        # Leer el teclado UNA sola vez
        tecla = cv2.waitKey(10) & 0xFF

        # Salir con Q
        if tecla == ord("q"):
            break

        # Guardar una muestra si se pulsa 1, 2 o 3
        if tecla in ETIQUETAS:
            if caracteristicas is not None:
                etiqueta = ETIQUETAS[tecla]

                escritor.writerow([
                    *caracteristicas,
                    etiqueta,
                ])

                archivo_csv.flush()
                print("Muestra guardada:", etiqueta)
            else:
                print("No se guardó: no se detectó una mano.")
finally:
    camara.release()
    cv2.destroyAllWindows()
    detector.close()

