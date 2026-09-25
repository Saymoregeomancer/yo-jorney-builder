# -*- mode: python ; coding: utf-8 -*-
# Збірка: pyinstaller --noconfirm YoJourneyBuilder.spec  (або build.bat)
import os
import eel

EEL_JS = os.path.join(os.path.dirname(eel.__file__), "eel.js")

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=[
        ("web", "web"),
        ("assets", "assets"),   # фон 810x853_2.jpg для обкладинок взуття
        (EEL_JS, "eel"),
    ],
    hiddenimports=["bottle_websocket"],
    excludes=["pandas", "matplotlib", "scipy", "IPython", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="YoJourneyBuilder",
    icon="assets/icon.ico",
    console=False,
    upx=False,
    runtime_tmpdir=None,
)
