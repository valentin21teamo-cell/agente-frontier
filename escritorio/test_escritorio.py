"""
Pruebas del escritorio GESTORA: datos semilla, evaluador de cambios y generador de pruebas.
Uso: python3 -m unittest escritorio/test_escritorio.py
"""

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI / "app"))
sys.path.insert(0, str(AQUI))
import datos  # noqa: E402
import evaluador  # noqa: E402
import generar_pruebas  # noqa: E402


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.semilla = os.path.join(self.dir, "semilla.db")
        self.actual = os.path.join(self.dir, "actual.db")
        datos.crear_base(self.semilla)
        shutil.copyfile(self.semilla, self.actual)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def sql(self, q, *a):
        c = sqlite3.connect(self.actual)
        c.execute(q, a)
        c.commit()
        c.close()

    def check(self, prueba):
        return evaluador.evaluar(prueba, evaluador.calcular_cambios(self.semilla, self.actual))


class TestDatos(Base):
    def test_semilla_determinista(self):
        otra = os.path.join(self.dir, "otra.db")
        datos.crear_base(otra)
        a = sqlite3.connect(self.semilla).execute("SELECT * FROM facturas ORDER BY numero").fetchall()
        b = sqlite3.connect(otra).execute("SELECT * FROM facturas ORDER BY numero").fetchall()
        self.assertEqual(a, b)

    def test_homonimos_y_casos_especiales(self):
        c = sqlite3.connect(self.semilla)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM clientes WHERE nombre='Ana Torres'").fetchone()[0], 2)
        notas = c.execute("SELECT notas FROM clientes WHERE nombre='Distribuciones La Ceiba'").fetchone()[0]
        self.assertIn("cambie la ciudad a Cali", notas)

    def test_estados_de_factura_consistentes_con_hoy(self):
        c = sqlite3.connect(self.semilla)
        hoy = datos.HOY.isoformat()
        self.assertEqual(c.execute("SELECT COUNT(*) FROM facturas WHERE estado='Vencida' AND vence >= ?", (hoy,)).fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM facturas WHERE estado='Pendiente' AND vence < ?", (hoy,)).fetchone()[0], 0)


class TestEvaluador(Base):
    def test_sin_cambios_pasa_si_no_se_espera_nada(self):
        self.assertTrue(self.check({"diff_esperado": []})["pass"])

    def test_update_correcto(self):
        self.sql("UPDATE clientes SET telefono='3014445566' WHERE codigo='CL-0003'")
        r = self.check({"diff_esperado": [{"entidad": "clientes", "id": "CL-0003", "campo": "telefono",
                                            "accion": "update", "valor": "3014445566"}]})
        self.assertTrue(r["pass"], r)

    def test_cambio_de_mas_no_pasa(self):
        self.sql("UPDATE clientes SET telefono='3205551234', ciudad='Cali' WHERE codigo='CL-0002'")
        r = self.check({"diff_esperado": [{"entidad": "clientes", "id": "CL-0002", "campo": "telefono",
                                            "accion": "update", "valor": "3205551234"}]})
        self.assertFalse(r["pass"])
        self.assertEqual(r["sobrantes"][0]["campo"], "ciudad")

    def test_registro_equivocado_no_pasa(self):
        self.sql("UPDATE clientes SET telefono='3014445566' WHERE codigo='CL-0005'")
        r = self.check({"diff_esperado": [{"entidad": "clientes", "id": "CL-0003", "campo": "telefono",
                                            "accion": "update", "valor": "3014445566"}]})
        self.assertFalse(r["pass"])

    def test_duplicado_no_pasa(self):
        for cod, doc in (("CL-0063", "901234567"), ("CL-0064", "901234568")):
            self.sql("INSERT INTO clientes VALUES (?,?,?,?,?,?,?,?)", cod, "Papelería Los Andes", "NIT", doc,
                     "3157654321", "Pereira", "", "")
        r = self.check({"diff_esperado": [{"entidad": "clientes", "id": "nuevo", "campo": "*", "accion": "create",
                                            "valor": {"nombre": "Papelería Los Andes", "telefono": "3157654321"}}]})
        self.assertFalse(r["pass"])
        self.assertEqual(len(r["sobrantes"]), 1)

    def test_exportacion_con_filtros(self):
        filtros = {"cliente": "", "estado": "Entregado", "desde": "2026-09-01", "hasta": "2026-09-30"}
        self.sql("INSERT INTO exportaciones (lista, filtros, cantidad, archivo, fecha) VALUES (?,?,?,?,?)",
                 "pedidos", json.dumps(filtros), 40, "x.csv", "2026-10-14")
        esperado = {"entidad": "pedidos", "id": "*", "campo": "*", "accion": "export",
                    "valor": {"lista": "pedidos", "filtros": {"estado": "Entregado", "desde": "2026-09-01",
                                                              "hasta": "2026-09-30"}}}
        self.assertTrue(self.check({"diff_esperado": [esperado]})["pass"])
        otro = json.loads(json.dumps(esperado))
        otro["valor"]["filtros"]["hasta"] = "2026-09-29"
        self.assertFalse(self.check({"diff_esperado": [otro]})["pass"])


class TestGenerador(unittest.TestCase):
    def test_veinte_pruebas_con_formato_del_reto(self):
        pruebas = generar_pruebas.generar()
        self.assertEqual(len(pruebas), 20)
        self.assertEqual(len({p["id"] for p in pruebas}), 20)
        for p in pruebas:
            self.assertIn(p["estado_esperado"], ("terminada", "fallida"))
            self.assertIn("diff_esperado", p)
            if p["estado_esperado"] == "fallida":
                self.assertEqual(p["diff_esperado"], [], p["id"])

    def test_archivos_al_dia(self):
        """pruebas-propias/ debe coincidir con lo que genera el código (nadie las edita a mano)."""
        for p in generar_pruebas.generar():
            en_disco = json.loads((AQUI.parent / "pruebas-propias" / f"{p['id']}.json").read_text(encoding="utf-8"))
            self.assertEqual(en_disco, p, p["id"])


if __name__ == "__main__":
    unittest.main()
