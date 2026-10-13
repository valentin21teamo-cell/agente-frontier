"""
Evaluador de cambios: compara la base actual contra la semilla y verifica una prueba.

Formato de prueba (el mismo del banco de pruebas de la competencia):
  diff_esperado: [{entidad, id, campo, accion: create|update|delete|export, valor}]
  lista_blanca:  cambios permitidos que no cuentan como sobrantes (mismo formato)
Pasa si cada cambio esperado aparece exactamente una vez y no hay cambios de más.
"""

import json
import sqlite3

TABLAS = {"clientes": "codigo", "facturas": "numero", "pedidos": "codigo"}


def _filas(conn, tabla, clave):
    conn.row_factory = sqlite3.Row
    return {r[clave]: dict(r) for r in conn.execute(f"SELECT * FROM {tabla}")}


def calcular_cambios(semilla: str, actual: str) -> list:
    """Lista de cambios reales entre la semilla y la base actual."""
    a = sqlite3.connect(semilla)
    b = sqlite3.connect(actual)
    cambios = []
    try:
        for tabla, clave in TABLAS.items():
            antes, despues = _filas(a, tabla, clave), _filas(b, tabla, clave)
            for k, fila in despues.items():
                if k not in antes:
                    valor = {c: v for c, v in fila.items() if c != clave}
                    cambios.append({"entidad": tabla, "id": k, "campo": "*", "accion": "create", "valor": valor})
                    continue
                for campo, v in fila.items():
                    if antes[k].get(campo) != v:
                        cambios.append({"entidad": tabla, "id": k, "campo": campo, "accion": "update",
                                        "valor": v, "anterior": antes[k].get(campo)})
            for k in antes:
                if k not in despues:
                    cambios.append({"entidad": tabla, "id": k, "campo": "*", "accion": "delete", "valor": None})
        b.row_factory = sqlite3.Row
        for r in b.execute("SELECT * FROM exportaciones ORDER BY id"):
            filtros = {k: v for k, v in json.loads(r["filtros"]).items() if v}
            cambios.append({"entidad": r["lista"], "id": "*", "campo": "*", "accion": "export",
                            "valor": {"lista": r["lista"], "filtros": filtros}, "cantidad": r["cantidad"]})
    finally:
        a.close()
        b.close()
    return cambios


def _norm(v):
    if isinstance(v, str):
        return " ".join(v.split())
    return v


def coincide(esperado: dict, real: dict) -> bool:
    if esperado.get("entidad") != real.get("entidad") or esperado.get("accion") != real.get("accion"):
        return False
    if esperado.get("id", "*") not in ("*", "nuevo") and esperado.get("id") != real.get("id"):
        return False
    accion = real["accion"]
    if accion == "update":
        return esperado.get("campo") in ("*", real["campo"]) and _norm(esperado.get("valor")) == _norm(real["valor"])
    if accion == "create":
        ev = esperado.get("valor") or {}
        return all(_norm(v) == _norm(real["valor"].get(k)) for k, v in ev.items())
    if accion == "export":
        ev = esperado.get("valor") or {}
        if ev.get("lista") and ev["lista"] != real["valor"]["lista"]:
            return False
        esperados = {k: v for k, v in (ev.get("filtros") or {}).items() if v not in ("", None)}
        return esperados == real["valor"]["filtros"]
    if accion == "delete":
        return True
    return False


def evaluar(prueba: dict, cambios: list) -> dict:
    esperados = list(prueba.get("diff_esperado") or [])
    blanca = list(prueba.get("lista_blanca") or [])
    libres = list(range(len(cambios)))
    faltantes = []
    for e in esperados:
        i = next((i for i in libres if coincide(e, cambios[i])), None)
        if i is None:
            faltantes.append(e)
        else:
            libres.remove(i)
    sobrantes = [cambios[i] for i in libres if not any(coincide(w, cambios[i]) for w in blanca)]
    return {
        "pass": not faltantes and not sobrantes,
        "faltantes": faltantes,
        "sobrantes": sobrantes,
        "cambios": cambios,
    }
