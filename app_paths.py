"""Шляхи застосунку, структура робочих папок і збережені налаштування."""

import json
import os
import sys

APP_NAME = "YoJourneyBuilder"

# ---------- Структура папок усередині Основної директорії ----------
DOWNLOADED_DIR = "downloaded-images"   # Step 3: завантажені фото (по підпапці на артикул)
PNG_DIR = "png"                        # вирізані PNG одягу — вхід для обкладинок одягу
PNG_SHOES_DIR = "png_shoes"            # вирізані PNG взуття — вхід для обкладинок взуття
PNG_BC_DIR = "png_bc"                  # використані PNG (архів, з нього робляться дитячі обкладинки)
COVERS_DIR = "обкладинки"              # готові обкладинки JPG
BACKUPS_DIR = "_backups"               # бекапи (ексель + png_bc)
BOT_DIR = "бот"                        # фото з бота: підпапка на кожен артикул (ці артикули не парсяться)
BAD_DIR = "bad"                        # браковані PNG, винесені з png_bc за списком bad.txt
BAD_TXT = "bad.txt"                    # список артикулів браку
CHILD_SHOES_TXT = "child_shoes.txt"    # список артикулів дитячого взуття
NOT_FOUND_TXT = "not_found.txt"        # список не знайдених артикулів

STRUCTURE = [DOWNLOADED_DIR, PNG_DIR, PNG_SHOES_DIR, PNG_BC_DIR, COVERS_DIR, BOT_DIR, BAD_DIR]


def is_frozen():
    return getattr(sys, "frozen", False)


def app_dir():
    """Папка, де лежить exe (або main.py при запуску з вихідників)."""
    if is_frozen():
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def resource_path(*parts):
    """Шлях до файлу, вбудованого у збірку (працює і з вихідників, і з exe)."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


BG_IMAGE = resource_path("assets", "810x853_2.jpg")


def data_dir():
    """%APPDATA%/YoJourneyBuilder — тут зберігаються налаштування та лог."""
    root = os.environ.get("APPDATA") or os.path.expanduser("~")
    path = os.path.join(root, APP_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def ensure_structure(base_path):
    for name in STRUCTURE:
        os.makedirs(os.path.join(base_path, name), exist_ok=True)


# ---------- Налаштування ----------
_CONFIG_FILE = "config.json"
_DEFAULTS = {
    "base_dir": "",
    "excel_path": "",
    "api_key": "",
    "region": "",
    "proxy": "",
    "theme": "dark",
}


def _config_path():
    return os.path.join(data_dir(), _CONFIG_FILE)


def load_config():
    config = dict(_DEFAULTS)
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            config.update(json.load(f))
    except (OSError, ValueError):
        pass
    return config


def save_config(**values):
    config = load_config()
    config.update({k: v for k, v in values.items() if k in _DEFAULTS})
    with open(_config_path(), "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config
