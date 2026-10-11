"""Entrenamiento final del VQC para piedra, papel o tijera.

- Entrena con gestos.csv + gestos_test.csv.
- Evalúa una sola vez sobre gestos_test_3.csv, reservado como prueba final.
- Usa una configuración fija de hiperparámetros y una única semilla.
"""

from pathlib import Path

import numpy as np
import pandas as pd

from qiskit.circuit.library import real_amplitudes, zz_feature_map
from qiskit_machine_learning.primitives import QMLSampler
from qiskit_machine_learning.algorithms import VQC
from qiskit_machine_learning.optimizers import COBYLA
from qiskit_machine_learning.utils import algorithm_globals

from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
)


# 1. CONFIGURACIÓN FIJA DEL EXPERIMENTO
# Datos de entrenamiento final: ambas sesiones conocidas.
ARCHIVOS_ENTRENAMIENTO = [
    Path("gestos.csv"),
    Path("gestos_test.csv"),
]

# Este conjunto se mantiene reservado para la evaluación final.
ARCHIVO_PRUEBA = Path("gestos_test_3.csv")

# Archivos de salida.
ARCHIVO_MODELO = Path("vqc_piedra_papel_tijera_seed_0.dill")
ARCHIVO_REPORTE = Path("resultado_prueba_final_vqc.txt")
ARCHIVO_PREDICCIONES = Path("predicciones_gestos_test_3.csv")

# Características y codificación de las clases.
COLUMNAS_CARACTERISTICAS = [
    "pulgar",
    "indice",
    "medio",
    "anular",
    "menique",
]

ETIQUETAS = {
    "piedra": 0,
    "papel": 1,
    "tijera": 2,
}
ETIQUETAS_INVERSAS = {valor: clave for clave, valor in ETIQUETAS.items()}

# Hiperparámetros elegidos: se mantienen sin cambios.
SEED = 0
ALPHA = 0.5
REPS_FEATURE_MAP = 1
REPS_ANSATZ = 1
MAXITER = 150

# Valores previstos: "local_exacto" o "ionq".
SIMULADOR = "local_exacto"

# 2. CARGA Y VALIDACIÓN DE DATOS
def cargar_y_procesar_gestos(ruta_archivo: Path):
    """Carga un CSV, valida las columnas y convierte las etiquetas a números."""
    if not ruta_archivo.is_file():
        raise FileNotFoundError(
            f"No se encontró el archivo: {ruta_archivo.resolve()}"
        )

    df = pd.read_csv(ruta_archivo)
    df.columns = df.columns.str.strip()

    columnas_requeridas = COLUMNAS_CARACTERISTICAS + ["label"]
    faltantes = [col for col in columnas_requeridas if col not in df.columns]
    if faltantes:
        raise ValueError(
            f"Faltan columnas en {ruta_archivo}: {faltantes}"
        )

    filas_iniciales = len(df)
    df = df.dropna(subset=columnas_requeridas).copy()
    filas_descartadas = filas_iniciales - len(df)

    df["label"] = (
        df["label"].astype(str).str.strip().str.lower()
    )

    y_series = df["label"].map(ETIQUETAS)
    if y_series.isna().any():
        desconocidas = sorted(df.loc[y_series.isna(), "label"].unique())
        raise ValueError(
            f"Hay etiquetas desconocidas en {ruta_archivo}: {desconocidas}"
        )

    X = df[COLUMNAS_CARACTERISTICAS].to_numpy(dtype=float)
    y = y_series.to_numpy(dtype=int)

    if not np.isfinite(X).all():
        raise ValueError(
            f"Hay valores no finitos en las características de {ruta_archivo}."
        )

    if len(df) == 0:
        raise ValueError(f"El archivo {ruta_archivo} no contiene muestras válidas.")

    return X, y, df, filas_descartadas


def cargar_datos_entrenamiento():
    """Combina las sesiones conocidas para entrenar el modelo final."""
    X_partes = []
    y_partes = []
    df_partes = []
    total_descartadas = 0

    for archivo in ARCHIVOS_ENTRENAMIENTO:
        X, y, df, descartadas = cargar_y_procesar_gestos(archivo)
        X_partes.append(X)
        y_partes.append(y)
        df_partes.append(df)
        total_descartadas += descartadas

    X_train = np.concatenate(X_partes, axis=0)
    y_train = np.concatenate(y_partes, axis=0)
    df_train = pd.concat(df_partes, ignore_index=True)

    clases_ausentes = sorted(set(ETIQUETAS.values()) - set(np.unique(y_train)))
    if clases_ausentes:
        nombres = [ETIQUETAS_INVERSAS[c] for c in clases_ausentes]
        raise ValueError(
            f"Faltan clases en el conjunto de entrenamiento: {nombres}"
        )

    return X_train, y_train, df_train, total_descartadas


# 3. SELECTOR DEL SIMULADOR
def crear_sampler():
    """Devuelve el sampler que utilizará el VQC.

    El sampler local exacto está listo para usarse. La conexión con IonQ se
    mantiene separada porque debe emplear la primitiva compatible con VQC que
    exponga el entorno de Qollab; no se debe asumir que un backend bruto sea
    directamente intercambiable por un Sampler V2.
    """
    if SIMULADOR == "local_exacto":
        # Sin muestreo por shots: calcula probabilidades exactas localmente.
        return QMLSampler(shots=None)

    if SIMULADOR == "ionq":
        return crear_sampler_ionq()

    raise ValueError(
        f"SIMULADOR no reconocido: {SIMULADOR!r}. "
        "Usa 'local_exacto' o 'ionq'."
    )


def crear_sampler_ionq():
    """Punto único de integración para Qollab/IonQ.

    Cuando confirmemos el paquete, el backend y la primitiva disponibles en la
    cuenta/entorno de Qollab, implementaremos aquí la construcción del sampler.
    El resto del entrenamiento no necesitará cambios.
    """
    raise NotImplementedError(
        "La integración con IonQ/Qollab aún no está configurada. "
        "Deja SIMULADOR = 'local_exacto' hasta confirmar la API y la primitiva "
        "compatible con VQC en el entorno de la hackatón."
    )


def interpretar_tres_clases(indice):
    """Agrupa los resultados de medida en las tres clases del problema."""
    return indice % 3


# 4. ENTRENAMIENTO Y PRUEBA FINAL
def main():
    print("=" * 65)
    print("ENTRENAMIENTO FINAL DEL VQC: PIEDRA, PAPEL O TIJERA")
    print("=" * 65)

    X_train, y_train, df_train, descartadas_train = cargar_datos_entrenamiento()
    X_test, y_test, df_test, descartadas_test = cargar_y_procesar_gestos(
        ARCHIVO_PRUEBA
    )

    print("\nDATOS")
    print("Archivos de entrenamiento:", ", ".join(map(str, ARCHIVOS_ENTRENAMIENTO)))
    print("Archivo de prueba final:", ARCHIVO_PRUEBA)
    print("Muestras de entrenamiento:", len(X_train))
    print("Muestras de prueba final:", len(X_test))
    print("Filas incompletas descartadas del entrenamiento:", descartadas_train)
    print("Filas incompletas descartadas de la prueba:", descartadas_test)
    print("\nDistribución de clases en entrenamiento:")
    print(df_train["label"].value_counts().reindex(ETIQUETAS, fill_value=0))
    print("\nDistribución de clases en prueba final:")
    print(df_test["label"].value_counts().reindex(ETIQUETAS, fill_value=0))

    # Fija el generador global antes de construir/entrenar el VQC.
    algorithm_globals.random_seed = SEED

    n_qubits = len(COLUMNAS_CARACTERISTICAS)
    feature_map = zz_feature_map(
        feature_dimension=n_qubits,
        reps=REPS_FEATURE_MAP,
        alpha=ALPHA,
    )
    ansatz = real_amplitudes(
        num_qubits=n_qubits,
        reps=REPS_ANSATZ,
    )

    sampler = crear_sampler()

    print("\nCONFIGURACIÓN FIJA")
    print("Semilla:", SEED)
    print("Simulador seleccionado:", SIMULADOR)
    print("Número de qubits:", n_qubits)
    print("Alpha:", ALPHA)
    print("Repeticiones de ZZFeatureMap:", REPS_FEATURE_MAP)
    print("Repeticiones de RealAmplitudes:", REPS_ANSATZ)
    print("Iteraciones máximas de COBYLA:", MAXITER)
    print("Parámetros del feature map:", feature_map.num_parameters)
    print("Parámetros variacionales:", ansatz.num_parameters)
    print("Sampler utilizado:", type(sampler).__name__)

    vqc = VQC(
        feature_map=feature_map,
        ansatz=ansatz,
        sampler=sampler,
        optimizer=COBYLA(maxiter=MAXITER),
        interpret=interpretar_tres_clases,
        output_shape=3,
    )

    print("\nIniciando entrenamiento...")
    vqc.fit(X_train, y_train)
    print("Entrenamiento finalizado.")

    # Esta es la única evaluación de selección final; no se ajustan parámetros
    # a partir de los resultados de gestos_test_3.csv.
    print("\nEvaluando en gestos_test_3.csv...")
    predicciones = np.asarray(vqc.predict(X_test))
    if predicciones.ndim == 2 and predicciones.shape[1] == 3:
        predicciones = np.argmax(predicciones, axis=1)
    else:
        predicciones = predicciones.ravel().astype(int)

    accuracy = accuracy_score(y_test, predicciones)
    f1_macro = f1_score(
        y_test,
        predicciones,
        labels=[0, 1, 2],
        average="macro",
        zero_division=0,
    )
    informe = classification_report(
        y_test,
        predicciones,
        labels=[0, 1, 2],
        target_names=["piedra", "papel", "tijera"],
        digits=4,
        zero_division=0,
    )
    matriz = confusion_matrix(y_test, predicciones, labels=[0, 1, 2])

    print("\nRESULTADOS DE LA PRUEBA FINAL")
    print(f"Accuracy: {accuracy:.2%}")
    print(f"F1 macro: {f1_macro:.4f}")
    print("\nInforme de clasificación:")
    print(informe)
    print("Matriz de confusión (filas = reales, columnas = predichas):")
    print(matriz)

    # Guardar el modelo entrenado.
    vqc.to_dill(str(ARCHIVO_MODELO))

    # Guardar predicciones para inspeccionar errores concretos.
    pd.DataFrame(
        {
            "label_real": [ETIQUETAS_INVERSAS[int(v)] for v in y_test],
            "label_predicho": [ETIQUETAS_INVERSAS[int(v)] for v in predicciones],
            "acierto": (y_test == predicciones),
        }
    ).to_csv(ARCHIVO_PREDICCIONES, index=False, encoding="utf-8-sig")

    # Guardar el resultado final y la configuración utilizada.
    with open(ARCHIVO_REPORTE, "w", encoding="utf-8") as f:
        f.write("RESULTADO DE LA PRUEBA FINAL DEL VQC\n")
        f.write("Piedra, papel o tijera\n")
        f.write("=" * 65 + "\n\n")
        f.write(f"Archivos de entrenamiento: {', '.join(map(str, ARCHIVOS_ENTRENAMIENTO))}\n")
        f.write(f"Archivo de prueba final: {ARCHIVO_PRUEBA}\n")
        f.write(f"Muestras de entrenamiento: {len(X_train)}\n")
        f.write(f"Muestras de prueba final: {len(X_test)}\n")
        f.write(f"Semilla: {SEED}\n")
        f.write(f"Simulador: {SIMULADOR}\n")
        f.write(f"Sampler: {type(sampler).__name__}\n")
        f.write(f"Qubits: {n_qubits}\n")
        f.write(f"Alpha: {ALPHA}\n")
        f.write(f"Reps feature map: {REPS_FEATURE_MAP}\n")
        f.write(f"Reps ansatz: {REPS_ANSATZ}\n")
        f.write(f"COBYLA maxiter: {MAXITER}\n\n")
        f.write(f"Accuracy: {accuracy:.6f}\n")
        f.write(f"F1 macro: {f1_macro:.6f}\n\n")
        f.write("Informe de clasificación:\n")
        f.write(informe)
        f.write("\nMatriz de confusión (filas = reales, columnas = predichas):\n")
        f.write(np.array2string(matriz))
        f.write("\n")

    print("\nARCHIVOS GUARDADOS")
    print("Modelo:", ARCHIVO_MODELO.resolve())
    print("Reporte:", ARCHIVO_REPORTE.resolve())
    print("Predicciones:", ARCHIVO_PREDICCIONES.resolve())


if __name__ == "__main__":
    main()
