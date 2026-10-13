"""
GESTORA ERP v3.1 — aplicación de escritorio "legada" de prueba (datos ficticios).

Pantalla fija de 1280x800, sin gestor de ventanas: todo vive en una sola ventana
(los formularios y diálogos son paneles internos). Se opera por VNC igual que un sistema real.

Uso: python3 gestora.py --db /ruta/gestora.db [--listo /tmp/app-listo]
"""

import argparse
import json
import sqlite3
import tkinter as tk
from tkinter import ttk

from datos import (
    CIUDADES, ESTADOS_FACTURA, ESTADOS_PEDIDO, HOY,
    fecha_a_iso, iso_a_fecha, normalizar, pesos,
)

ANCHO, ALTO = 1280, 800
FUENTE = ("DejaVu Sans", 10)
FUENTE_B = ("DejaVu Sans", 10, "bold")
FUENTE_T = ("DejaVu Sans", 14, "bold")
C_CABECERA = "#1f3a5f"
C_FONDO = "#dfe3e8"
C_PANEL = "#f6f7f9"
C_OK = "#1d6b3a"
C_ERR = "#a3261b"
POR_PAGINA = 20


class Gestora:
    def __init__(self, root: tk.Tk, db: str):
        self.root = root
        self.db = sqlite3.connect(db)
        self.db.row_factory = sqlite3.Row
        root.title("GESTORA ERP v3.1")
        root.geometry(f"{ANCHO}x{ALTO}+0+0")
        root.configure(bg=C_FONDO)
        root.resizable(False, False)

        st = ttk.Style(root)
        st.theme_use("clam")
        st.configure(".", font=FUENTE)
        st.configure("Treeview", rowheight=24, font=FUENTE)
        st.configure("Treeview.Heading", font=FUENTE_B)
        st.configure("TButton", padding=(10, 4))
        st.configure("Accion.TButton", padding=(12, 6))
        root.option_add("*TCombobox*Listbox.font", FUENTE)

        self._cabecera()
        self._menu()
        self.contenido = tk.Frame(root, bg=C_FONDO)
        self.contenido.pack(fill="both", expand=True)
        self.estado = tk.Label(root, text="Listo.", anchor="w", bg="#c9ced6", font=FUENTE, padx=8)
        self.estado.pack(fill="x", side="bottom")
        self.overlay = None
        self.inicio()
        self.novedades()

    # ------------------------------------------------------------------ marco general
    def _cabecera(self):
        cab = tk.Frame(self.root, bg=C_CABECERA, height=36)
        cab.pack(fill="x")
        cab.pack_propagate(False)
        tk.Label(cab, text="GESTORA ERP · Comercial Demo S.A.S.", fg="white", bg=C_CABECERA,
                 font=("DejaVu Sans", 11, "bold")).pack(side="left", padx=12)
        tk.Label(cab, text="v3.1", fg="#c7d3e3", bg=C_CABECERA, font=FUENTE).pack(side="left")
        tk.Label(cab, text=f"Hoy: {HOY.strftime('%d/%m/%Y')} · Usuario: operador1", fg="white",
                 bg=C_CABECERA, font=FUENTE).pack(side="right", padx=12)

    def _menu(self):
        barra = tk.Frame(self.root, bg="#eef0f3", bd=1, relief="raised")
        barra.pack(fill="x")

        def boton(texto):
            mb = tk.Menubutton(barra, text=texto, font=FUENTE, bg="#eef0f3", activebackground="#cfd8e6",
                               padx=10, pady=4)
            mb.pack(side="left")
            m = tk.Menu(mb, tearoff=0, font=FUENTE, activebackground="#c5d3e8", activeforeground="black")
            mb.configure(menu=m)
            return m

        archivo = boton("Archivo")
        archivo.add_command(label="Inicio", command=self.inicio)
        archivo.add_separator()
        archivo.add_command(label="Salir", command=lambda: self.aviso(
            "Salir", "En modo quiosco no se puede cerrar la aplicación."))

        comercial = boton("Comercial")
        maestros = tk.Menu(comercial, tearoff=0, font=FUENTE, activebackground="#c5d3e8", activeforeground="black")
        maestros.add_command(label="Clientes", command=self.clientes)
        comercial.add_cascade(label="Maestros", menu=maestros)
        ventas = tk.Menu(comercial, tearoff=0, font=FUENTE, activebackground="#c5d3e8", activeforeground="black")
        ventas.add_command(label="Pedidos", command=self.pedidos)
        comercial.add_cascade(label="Ventas", menu=ventas)

        cartera = boton("Cartera")
        cartera.add_command(label="Facturas", command=self.facturas)

        herramientas = boton("Herramientas")
        herramientas.add_command(label="Exportaciones realizadas", command=self.exportaciones)

        ayuda = boton("Ayuda")
        ayuda.add_command(label="Acerca de", command=lambda: self.aviso(
            "Acerca de", "GESTORA ERP v3.1 — aplicación de prueba con datos ficticios."))

    def limpiar(self, titulo: str):
        self.cerrar_overlay()
        for w in self.contenido.winfo_children():
            w.destroy()
        tk.Label(self.contenido, text=titulo, font=FUENTE_T, bg=C_FONDO, anchor="w").pack(
            fill="x", padx=16, pady=(12, 6))
        cuerpo = tk.Frame(self.contenido, bg=C_FONDO)
        cuerpo.pack(fill="both", expand=True, padx=16)
        return cuerpo

    def mensaje(self, texto: str):
        self.estado.configure(text=texto)

    # ------------------------------------------------------------------ diálogos internos
    def cerrar_overlay(self):
        if self.overlay is not None:
            try:
                self.overlay.grab_release()
                self.overlay.destroy()
            except tk.TclError:
                pass
            self.overlay = None

    def dialogo(self, titulo: str, cuerpo: str, botones, ancho=520):
        """Panel modal centrado. botones: lista de (texto, función)."""
        self.cerrar_overlay()
        ov = tk.Frame(self.root, bg="white", bd=1, relief="solid", highlightthickness=1,
                      highlightbackground="#5b6b80")
        self.overlay = ov
        tk.Label(ov, text=titulo, bg=C_CABECERA, fg="white", font=FUENTE_B, anchor="w", padx=10,
                 pady=6).pack(fill="x")
        tk.Label(ov, text=cuerpo, bg="white", font=FUENTE, justify="left", wraplength=ancho - 40,
                 anchor="w", padx=16, pady=14).pack(fill="x")
        fila = tk.Frame(ov, bg="white")
        fila.pack(fill="x", padx=12, pady=(0, 12))
        for texto, fn in reversed(botones):
            ttk.Button(fila, text=texto, command=fn).pack(side="right", padx=4)
        ov.place(relx=0.5, rely=0.45, anchor="center", width=ancho)
        ov.lift()
        ov.grab_set()

    def aviso(self, titulo, texto):
        self.dialogo(titulo, texto, [("Aceptar", self.cerrar_overlay)], ancho=440)

    def novedades(self):
        self.dialogo(
            "Novedades de la versión 3.1",
            "Actualizamos el sistema. Lo más importante:\n\n"
            "•  El botón Guardar ahora deja el formulario abierto para seguir trabajando.\n"
            "•  Los filtros de fecha usan el formato dd/mm/aaaa.\n"
            "•  Exportar una lista pide confirmación antes de generar el archivo.",
            [("Entendido", self.cerrar_overlay)],
        )

    # ------------------------------------------------------------------ inicio
    def inicio(self):
        c = self.limpiar("Bienvenido a GESTORA ERP")
        tk.Label(c, text="Sistema comercial. Use el menú superior para entrar a los módulos.",
                 bg=C_FONDO, font=FUENTE, anchor="w").pack(fill="x")
        tk.Label(c, text="Mesa de ayuda: extensión 330 (horario de oficina).", bg=C_FONDO,
                 fg="#4a5563", font=FUENTE, anchor="w").pack(fill="x", pady=(6, 0))
        self.mensaje("Listo.")

    # ------------------------------------------------------------------ utilidades de listas
    def tabla(self, padre, columnas, alto=POR_PAGINA):
        cols = [c[0] for c in columnas]
        tv = ttk.Treeview(padre, columns=cols, show="headings", height=alto, selectmode="browse")
        for nombre, ancho, alin in columnas:
            tv.heading(nombre, text=nombre, anchor="w")
            tv.column(nombre, width=ancho, anchor=alin, stretch=False)
        return tv

    def paginador(self, padre, estado, recargar, sufijo):
        fila = tk.Frame(padre, bg=C_FONDO)
        etiqueta = tk.Label(fila, bg=C_FONDO, font=FUENTE)
        etiqueta.pack(side="left")

        def mover(d):
            total = estado["total"]
            paginas = max(1, (total + POR_PAGINA - 1) // POR_PAGINA)
            estado["pagina"] = min(max(0, estado["pagina"] + d), paginas - 1)
            recargar()

        ttk.Button(fila, text="Siguiente ▶", command=lambda: mover(1)).pack(side="right")
        ttk.Button(fila, text="◀ Anterior", command=lambda: mover(-1)).pack(side="right", padx=6)

        def actualizar():
            total = estado["total"]
            ini = estado["pagina"] * POR_PAGINA
            fin = min(total, ini + POR_PAGINA)
            paginas = max(1, (total + POR_PAGINA - 1) // POR_PAGINA)
            if total == 0:
                etiqueta.configure(text=f"Sin {sufijo} para los filtros actuales.")
            else:
                extra = estado.get("extra", "")
                etiqueta.configure(
                    text=f"Mostrando {ini + 1}–{fin} de {total} {sufijo} · Página {estado['pagina'] + 1} de {paginas}{extra}")

        return fila, actualizar

    # ------------------------------------------------------------------ clientes
    def clientes(self):
        c = self.limpiar("Clientes")
        estado = {"pagina": 0, "total": 0}
        izq = tk.Frame(c, bg=C_FONDO)
        izq.pack(side="left", fill="both", expand=True)
        der = tk.Frame(c, bg=C_FONDO)
        der.pack(side="right", fill="y", padx=(12, 0))

        filtros = tk.Frame(izq, bg=C_FONDO)
        filtros.pack(fill="x", pady=(0, 8))
        tk.Label(filtros, text="Buscar (nombre o documento):", bg=C_FONDO).pack(side="left")
        e_buscar = ttk.Entry(filtros, width=28)
        e_buscar.pack(side="left", padx=6)
        tk.Label(filtros, text="Ciudad:", bg=C_FONDO).pack(side="left", padx=(8, 0))
        cb_ciudad = ttk.Combobox(filtros, values=["Todas"] + CIUDADES, state="readonly", width=14)
        cb_ciudad.set("Todas")
        cb_ciudad.pack(side="left", padx=6)

        tv = self.tabla(izq, [("Código", 90, "w"), ("Nombre", 330, "w"), ("Documento", 150, "w"),
                              ("Teléfono", 130, "w"), ("Ciudad", 140, "w")])
        tv.pack(anchor="w")

        def recargar():
            q = normalizar(e_buscar.get())
            ciudad = cb_ciudad.get()
            filas = []
            for r in self.db.execute("SELECT * FROM clientes ORDER BY codigo"):
                if q and q not in normalizar(r["nombre"]) and q not in r["documento"]:
                    continue
                if ciudad and ciudad != "Todas" and r["ciudad"] != ciudad:
                    continue
                filas.append(r)
            estado["total"] = len(filas)
            tope = (max(0, len(filas) - 1)) // POR_PAGINA
            estado["pagina"] = min(estado["pagina"], tope)
            tv.delete(*tv.get_children())
            ini = estado["pagina"] * POR_PAGINA
            for r in filas[ini:ini + POR_PAGINA]:
                tv.insert("", "end", iid=r["codigo"], values=(
                    r["codigo"], r["nombre"], f"{r['tipo_doc']} {r['documento']}", r["telefono"], r["ciudad"]))
            actualizar()

        def buscar():
            estado["pagina"] = 0
            recargar()

        def limpiar_f():
            e_buscar.delete(0, "end")
            cb_ciudad.set("Todas")
            buscar()

        ttk.Button(filtros, text="Buscar", command=buscar).pack(side="left", padx=4)
        ttk.Button(filtros, text="Limpiar", command=limpiar_f).pack(side="left")
        e_buscar.bind("<Return>", lambda _e: buscar())

        fila, actualizar = self.paginador(izq, estado, recargar, "clientes")
        fila.pack(fill="x", pady=8)

        def editar_sel():
            sel = tv.selection()
            if not sel:
                self.aviso("Editar cliente", "Seleccione primero un cliente de la lista.")
                return
            self.form_cliente(sel[0])

        tv.bind("<Double-1>", lambda e: (tv.identify_row(e.y) and self.form_cliente(tv.identify_row(e.y))))
        tk.Label(der, text="Acciones", bg=C_FONDO, font=FUENTE_B).pack(anchor="w", pady=(0, 6))
        ttk.Button(der, text="Nuevo cliente", style="Accion.TButton", width=18,
                   command=lambda: self.form_cliente(None)).pack(pady=3)
        ttk.Button(der, text="Editar seleccionado", style="Accion.TButton", width=18,
                   command=editar_sel).pack(pady=3)
        recargar()
        self.mensaje("Clientes: doble clic en una fila para editar.")

    def form_cliente(self, codigo):
        r = self.db.execute("SELECT * FROM clientes WHERE codigo=?", (codigo,)).fetchone() if codigo else None
        c = self.limpiar(f"Editar cliente {codigo}" if r else "Nuevo cliente")
        actual = {"codigo": codigo if r else None}
        izq = tk.Frame(c, bg=C_FONDO)
        izq.pack(side="left", fill="both", expand=True)
        der = tk.Frame(c, bg=C_FONDO)
        der.pack(side="right", fill="y", padx=(12, 0))
        titulo = self.contenido.winfo_children()[0]

        grid = tk.Frame(izq, bg=C_PANEL, bd=1, relief="solid", padx=16, pady=14)
        grid.pack(anchor="nw")
        campos = {}

        def fila(i, etiqueta, widget):
            tk.Label(grid, text=etiqueta, bg=C_PANEL, anchor="w", width=24).grid(row=i, column=0, sticky="w", pady=5)
            widget.grid(row=i, column=1, sticky="w", pady=5)

        campos["nombre"] = ttk.Entry(grid, width=46)
        fila(0, "Nombre o razón social", campos["nombre"])
        campos["tipo_doc"] = ttk.Combobox(grid, values=["NIT", "CC"], state="readonly", width=8)
        fila(1, "Tipo de documento", campos["tipo_doc"])
        campos["documento"] = ttk.Entry(grid, width=20)
        fila(2, "Número de documento", campos["documento"])
        campos["telefono"] = ttk.Entry(grid, width=20)
        fila(3, "Teléfono", campos["telefono"])
        campos["ciudad"] = ttk.Combobox(grid, values=CIUDADES, state="readonly", width=18)
        fila(4, "Ciudad", campos["ciudad"])
        campos["direccion"] = ttk.Entry(grid, width=46)
        fila(5, "Dirección", campos["direccion"])
        notas = tk.Text(grid, width=46, height=4, font=FUENTE, relief="solid", bd=1, wrap="word")
        fila(6, "Notas", notas)

        if r:
            for k in ("nombre", "documento", "telefono", "direccion"):
                campos[k].insert(0, r[k])
            campos["tipo_doc"].set(r["tipo_doc"])
            campos["ciudad"].set(r["ciudad"])
            notas.insert("1.0", r["notas"])
        else:
            campos["tipo_doc"].set("NIT")

        resultado = tk.Label(izq, text="", bg=C_FONDO, font=FUENTE_B, anchor="w", justify="left")
        resultado.pack(fill="x", pady=10)

        def guardar():
            v = {k: (w.get().strip()) for k, w in campos.items()}
            v["nombre"] = " ".join(v["nombre"].split())
            v["notas"] = notas.get("1.0", "end").strip()
            errores = []
            if len(v["nombre"]) < 3:
                errores.append("El nombre es obligatorio.")
            if not v["documento"].isdigit() or not (6 <= len(v["documento"]) <= 10):
                errores.append("El documento debe tener entre 6 y 10 dígitos, sin puntos ni guiones.")
            if not (v["telefono"].isdigit() and len(v["telefono"]) == 10):
                errores.append("El teléfono debe tener 10 dígitos.")
            if v["ciudad"] not in CIUDADES:
                errores.append("Seleccione una ciudad de la lista.")
            otro = self.db.execute("SELECT codigo, nombre FROM clientes WHERE documento=? AND codigo IS NOT ?",
                                   (v["documento"], actual["codigo"])).fetchone()
            if otro:
                errores.append(f"Ya existe un cliente con ese documento: {otro['codigo']} {otro['nombre']}.")
            if errores:
                resultado.configure(text="No se guardó:\n• " + "\n• ".join(errores), fg=C_ERR)
                self.mensaje("Revise los datos del formulario.")
                return
            if actual["codigo"]:
                self.db.execute(
                    "UPDATE clientes SET nombre=?, tipo_doc=?, documento=?, telefono=?, ciudad=?, direccion=?, notas=? "
                    "WHERE codigo=?",
                    (v["nombre"], v["tipo_doc"], v["documento"], v["telefono"], v["ciudad"], v["direccion"],
                     v["notas"], actual["codigo"]))
            else:
                n = self.db.execute("SELECT COUNT(*) FROM clientes").fetchone()[0] + 1
                nuevo = f"CL-{n:04d}"
                while self.db.execute("SELECT 1 FROM clientes WHERE codigo=?", (nuevo,)).fetchone():
                    n += 1
                    nuevo = f"CL-{n:04d}"
                self.db.execute("INSERT INTO clientes VALUES (?,?,?,?,?,?,?,?)",
                                (nuevo, v["nombre"], v["tipo_doc"], v["documento"], v["telefono"], v["ciudad"],
                                 v["direccion"], v["notas"]))
                actual["codigo"] = nuevo
                titulo.configure(text=f"Editar cliente {nuevo}")
            self.db.commit()
            resultado.configure(text=f"✔ Cambios guardados en {actual['codigo']}.", fg=C_OK)
            self.mensaje(f"Cliente {actual['codigo']} guardado.")

        tk.Label(der, text="Acciones", bg=C_FONDO, font=FUENTE_B).pack(anchor="w", pady=(0, 6))
        ttk.Button(der, text="Guardar", style="Accion.TButton", width=18, command=guardar).pack(pady=3)
        ttk.Button(der, text="Volver a la lista", style="Accion.TButton", width=18,
                   command=self.clientes).pack(pady=3)
        self.mensaje("Complete el formulario y pulse Guardar.")

    # ------------------------------------------------------------------ facturas
    def facturas(self):
        c = self.limpiar("Facturas")
        estado = {"pagina": 0, "total": 0}
        filtros = tk.Frame(c, bg=C_FONDO)
        filtros.pack(fill="x", pady=(0, 8))
        tk.Label(filtros, text="Cliente:", bg=C_FONDO).pack(side="left")
        e_cli = ttk.Entry(filtros, width=24)
        e_cli.pack(side="left", padx=6)
        tk.Label(filtros, text="Estado:", bg=C_FONDO).pack(side="left", padx=(8, 0))
        cb_est = ttk.Combobox(filtros, values=["Todos"] + ESTADOS_FACTURA, state="readonly", width=11)
        cb_est.set("Todos")
        cb_est.pack(side="left", padx=6)
        tk.Label(filtros, text="Desde:", bg=C_FONDO).pack(side="left", padx=(8, 0))
        e_desde = ttk.Entry(filtros, width=11)
        e_desde.pack(side="left", padx=6)
        tk.Label(filtros, text="Hasta:", bg=C_FONDO).pack(side="left")
        e_hasta = ttk.Entry(filtros, width=11)
        e_hasta.pack(side="left", padx=6)

        tv = self.tabla(c, [("Número", 100, "w"), ("Cliente", 320, "w"), ("Fecha", 110, "w"),
                            ("Vence", 110, "w"), ("Valor", 140, "e"), ("Estado", 110, "w")])
        tv.pack(anchor="w")
        error = tk.Label(c, text="", bg=C_FONDO, fg=C_ERR, font=FUENTE_B, anchor="w")

        def recargar():
            q = normalizar(e_cli.get())
            est = cb_est.get()
            desde, hasta = e_desde.get().strip(), e_hasta.get().strip()
            d_iso = fecha_a_iso(desde) if desde else None
            h_iso = fecha_a_iso(hasta) if hasta else None
            if (desde and not d_iso) or (hasta and not h_iso):
                error.configure(text="Fecha inválida: use el formato dd/mm/aaaa.")
                return
            error.configure(text="")
            filas = []
            for r in self.db.execute(
                    "SELECT f.*, c.nombre FROM facturas f JOIN clientes c ON c.codigo=f.cliente ORDER BY f.numero"):
                if q and q not in normalizar(r["nombre"]):
                    continue
                if est != "Todos" and r["estado"] != est:
                    continue
                if d_iso and r["fecha"] < d_iso:
                    continue
                if h_iso and r["fecha"] > h_iso:
                    continue
                filas.append(r)
            estado["total"] = len(filas)
            estado["extra"] = f" · Total filtrado: {pesos(sum(r['valor'] for r in filas))}" if filas else ""
            estado["pagina"] = min(estado["pagina"], max(0, len(filas) - 1) // POR_PAGINA)
            tv.delete(*tv.get_children())
            ini = estado["pagina"] * POR_PAGINA
            for r in filas[ini:ini + POR_PAGINA]:
                tv.insert("", "end", values=(r["numero"], r["nombre"], iso_a_fecha(r["fecha"]),
                                             iso_a_fecha(r["vence"]), pesos(r["valor"]), r["estado"]))
            actualizar()

        def filtrar():
            estado["pagina"] = 0
            recargar()

        def limpiar_f():
            for e in (e_cli, e_desde, e_hasta):
                e.delete(0, "end")
            cb_est.set("Todos")
            filtrar()

        ttk.Button(filtros, text="Filtrar", command=filtrar).pack(side="left", padx=4)
        ttk.Button(filtros, text="Limpiar", command=limpiar_f).pack(side="left")
        for e in (e_cli, e_desde, e_hasta):
            e.bind("<Return>", lambda _e: filtrar())
        fila, actualizar = self.paginador(c, estado, recargar, "facturas")
        fila.pack(fill="x", pady=8)
        error.pack(fill="x")
        recargar()
        self.mensaje("Facturas: use los filtros y pulse Filtrar.")

    # ------------------------------------------------------------------ pedidos
    def pedidos(self):
        c = self.limpiar("Pedidos")
        estado = {"pagina": 0, "total": 0}
        aplicados = {"cliente": "", "estado": "Todos", "desde": None, "hasta": None, "filas": []}
        izq = tk.Frame(c, bg=C_FONDO)
        izq.pack(side="left", fill="both", expand=True)
        der = tk.Frame(c, bg=C_FONDO)
        der.pack(side="right", fill="y", padx=(12, 0))

        filtros = tk.Frame(izq, bg=C_FONDO)
        filtros.pack(fill="x", pady=(0, 8))
        tk.Label(filtros, text="Cliente:", bg=C_FONDO).pack(side="left")
        e_cli = ttk.Entry(filtros, width=20)
        e_cli.pack(side="left", padx=6)
        tk.Label(filtros, text="Estado:", bg=C_FONDO).pack(side="left", padx=(6, 0))
        cb_est = ttk.Combobox(filtros, values=["Todos"] + ESTADOS_PEDIDO, state="readonly", width=11)
        cb_est.set("Todos")
        cb_est.pack(side="left", padx=6)
        tk.Label(filtros, text="Desde:", bg=C_FONDO).pack(side="left", padx=(6, 0))
        e_desde = ttk.Entry(filtros, width=11)
        e_desde.pack(side="left", padx=6)
        tk.Label(filtros, text="Hasta:", bg=C_FONDO).pack(side="left")
        e_hasta = ttk.Entry(filtros, width=11)
        e_hasta.pack(side="left", padx=6)

        tv = self.tabla(izq, [("Código", 90, "w"), ("Cliente", 300, "w"), ("Fecha", 110, "w"),
                              ("Estado", 110, "w"), ("Valor", 130, "e")])
        tv.pack(anchor="w")
        error = tk.Label(izq, text="", bg=C_FONDO, fg=C_ERR, font=FUENTE_B, anchor="w")

        def recargar():
            q = normalizar(e_cli.get())
            est = cb_est.get()
            desde, hasta = e_desde.get().strip(), e_hasta.get().strip()
            d_iso = fecha_a_iso(desde) if desde else None
            h_iso = fecha_a_iso(hasta) if hasta else None
            if (desde and not d_iso) or (hasta and not h_iso):
                error.configure(text="Fecha inválida: use el formato dd/mm/aaaa.")
                return
            error.configure(text="")
            filas = []
            for r in self.db.execute(
                    "SELECT p.*, c.nombre FROM pedidos p JOIN clientes c ON c.codigo=p.cliente ORDER BY p.codigo"):
                if q and q not in normalizar(r["nombre"]):
                    continue
                if est != "Todos" and r["estado"] != est:
                    continue
                if d_iso and r["fecha"] < d_iso:
                    continue
                if h_iso and r["fecha"] > h_iso:
                    continue
                filas.append(r)
            aplicados.update(cliente=e_cli.get().strip(), estado=est, desde=d_iso, hasta=h_iso, filas=filas)
            estado["total"] = len(filas)
            estado["pagina"] = min(estado["pagina"], max(0, len(filas) - 1) // POR_PAGINA)
            tv.delete(*tv.get_children())
            ini = estado["pagina"] * POR_PAGINA
            for r in filas[ini:ini + POR_PAGINA]:
                tv.insert("", "end", iid=r["codigo"], values=(
                    r["codigo"], r["nombre"], iso_a_fecha(r["fecha"]), r["estado"], pesos(r["valor"])))
            actualizar()

        def filtrar():
            estado["pagina"] = 0
            recargar()

        def limpiar_f():
            for e in (e_cli, e_desde, e_hasta):
                e.delete(0, "end")
            cb_est.set("Todos")
            filtrar()

        ttk.Button(filtros, text="Filtrar", command=filtrar).pack(side="left", padx=4)
        ttk.Button(filtros, text="Limpiar", command=limpiar_f).pack(side="left")
        for e in (e_cli, e_desde, e_hasta):
            e.bind("<Return>", lambda _e: filtrar())
        fila, actualizar = self.paginador(izq, estado, recargar, "pedidos")
        fila.pack(fill="x", pady=8)
        error.pack(fill="x")

        def exportar():
            n = len(aplicados["filas"])
            if n == 0:
                self.aviso("Exportar lista", "No hay pedidos para exportar con los filtros actuales.")
                return
            partes = [f"Estado: {aplicados['estado']}"]
            if aplicados["cliente"]:
                partes.append(f"Cliente: {aplicados['cliente']}")
            if aplicados["desde"]:
                partes.append(f"Desde: {iso_a_fecha(aplicados['desde'])}")
            if aplicados["hasta"]:
                partes.append(f"Hasta: {iso_a_fecha(aplicados['hasta'])}")

            def confirmar():
                k = self.db.execute("SELECT COUNT(*) FROM exportaciones").fetchone()[0] + 1
                archivo = f"pedidos_{HOY.strftime('%Y%m%d')}_{k:03d}.csv"
                filtros_json = {
                    "cliente": aplicados["cliente"],
                    "estado": "" if aplicados["estado"] == "Todos" else aplicados["estado"],
                    "desde": aplicados["desde"] or "",
                    "hasta": aplicados["hasta"] or "",
                }
                self.db.execute("INSERT INTO exportaciones (lista, filtros, cantidad, archivo, fecha) VALUES (?,?,?,?,?)",
                                ("pedidos", json.dumps(filtros_json, ensure_ascii=False), n, archivo, HOY.isoformat()))
                self.db.commit()
                self.dialogo("Exportación generada",
                             f"Se generó el archivo {archivo} con {n} pedidos.",
                             [("Aceptar", self.cerrar_overlay)], ancho=460)
                self.mensaje(f"Exportación generada: {archivo} ({n} registros).")

            self.dialogo("Exportar lista de pedidos",
                         f"Se exportarán {n} pedidos con los filtros actuales ({', '.join(partes)}).\n¿Desea continuar?",
                         [("Exportar", confirmar), ("Cancelar", self.cerrar_overlay)])

        def anular():
            sel = tv.selection()
            if not sel:
                self.aviso("Anular pedido", "Seleccione primero un pedido de la lista.")
                return
            r = self.db.execute("SELECT p.*, c.nombre FROM pedidos p JOIN clientes c ON c.codigo=p.cliente "
                                "WHERE p.codigo=?", (sel[0],)).fetchone()
            if r["estado"] in ("Entregado", "Anulado"):
                self.aviso("Anular pedido", f"El pedido {r['codigo']} está {r['estado'].lower()} y no se puede anular.")
                return

            def confirmar():
                self.db.execute("UPDATE pedidos SET estado='Anulado' WHERE codigo=?", (r["codigo"],))
                self.db.commit()
                self.cerrar_overlay()
                recargar()
                self.mensaje(f"Pedido {r['codigo']} anulado.")

            self.dialogo("Anular pedido",
                         f"¿Anular el pedido {r['codigo']} de {r['nombre']} por {pesos(r['valor'])}?\n"
                         "Esta acción no se puede deshacer.",
                         [("Anular", confirmar), ("Cancelar", self.cerrar_overlay)])

        tk.Label(der, text="Acciones", bg=C_FONDO, font=FUENTE_B).pack(anchor="w", pady=(0, 6))
        ttk.Button(der, text="Exportar lista…", style="Accion.TButton", width=18, command=exportar).pack(pady=3)
        ttk.Button(der, text="Anular pedido", style="Accion.TButton", width=18, command=anular).pack(pady=3)
        recargar()
        self.mensaje("Pedidos: use los filtros; Exportar usa los filtros aplicados.")

    # ------------------------------------------------------------------ exportaciones
    def exportaciones(self):
        c = self.limpiar("Exportaciones realizadas")
        tv = self.tabla(c, [("Archivo", 260, "w"), ("Lista", 100, "w"), ("Registros", 100, "e"),
                            ("Filtros", 500, "w")], alto=15)
        tv.pack(anchor="w")
        for r in self.db.execute("SELECT * FROM exportaciones ORDER BY id"):
            f = json.loads(r["filtros"])
            txt = ", ".join(f"{k}: {v}" for k, v in f.items() if v)
            tv.insert("", "end", values=(r["archivo"], r["lista"], r["cantidad"], txt or "(sin filtros)"))
        self.mensaje("Listado de exportaciones.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--listo", default="")
    a = ap.parse_args()
    root = tk.Tk()
    Gestora(root, a.db)

    def avisar_listo():
        if a.listo:
            with open(a.listo, "w") as fh:
                fh.write("ok")

    root.after(400, avisar_listo)
    root.mainloop()


if __name__ == "__main__":
    main()
