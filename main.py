import atexit
import base64
import functools
import io
import itertools
import json
import math
import os
import random
import threading
import shutil
import sys
import tempfile
import traceback
import zipfile
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime
from pathlib import Path

import eel
import tkinter as tk
from tkinter import filedialog
from collections import OrderedDict

from PIL import Image, ImageOps

import app_paths as ap
from download import download_image, generate_params, normalize_filename, req, search_in_data
from img_processor import (
    DEFAULT_MAX_ANGLE,
    create_child_shoes_cover,
    create_cover_other,
    create_cover_with_background,
)
from utils import (
    IMAGE_EXTENSIONS,
    cell_text,
    ensure_dir,
    list_images,
    move_file,
    read_excel_rows,
    read_lines,
    write_lines,
)


class UserError(Exception):
    """Помилка, яку треба просто показати користувачу."""


# ------------------------------------------------------------------ інфраструктура
def operation(func):
    """Обгортка для дій з UI: завжди повертає {ok, error, ...}."""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            result = func(*args, **kwargs) or {}
            return {"ok": True, "error": None, **result}
        except UserError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            traceback.print_exc()
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    return wrapper


class Progress:
    def __init__(self, total, start=0, end=100):
        self.total = max(1, total)
        self.start, self.end = start, end
        self.done = 0
        self.set(start)

    @staticmethod
    def set(percent, text=None):
        eel.setProgress(int(percent), text)
        eel.sleep(0)

    def step(self, text=None):
        self.done += 1
        self.set(self.start + (self.end - self.start) * self.done / self.total, text)

    def finish(self, text=None):
        self.set(100, text)


def _run_dialog(dialog_func, **kwargs):
    """tkinter-діалог поверх усіх вікон. Eel виконує виклики з JS у greenlet-ах
    головного потоку, тому tkinter можна використовувати прямо тут."""
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        result = dialog_func(parent=root, **kwargs)
    finally:
        root.destroy()
    return result or None


def _initialdir(start_path):
    """Найближча існуюча папка для старту діалогу."""
    if not start_path:
        return None
    path = os.path.abspath(start_path)
    while path and not os.path.isdir(path):
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent
    return path or None


def _dialog_kwargs(start_path=None, **extra):
    kwargs = dict(extra)
    initialdir = _initialdir(start_path) or _initialdir(ap.load_config()["base_dir"])
    if initialdir:
        kwargs["initialdir"] = initialdir
    return kwargs


def require_base():
    base = ap.load_config()["base_dir"]
    if not base or not os.path.isdir(base):
        raise UserError("Спочатку виберіть Основну директорію.")
    return base


def require_excel():
    excel = ap.load_config()["excel_path"]
    if not excel or not os.path.isfile(excel):
        raise UserError("Спочатку виберіть Excel файл.")
    return excel


def base_sub(*parts):
    return os.path.join(require_base(), *parts)


def _resolve_subdir(subdir):
    base = require_base()
    path = os.path.normpath(os.path.join(base, subdir or ""))
    if not os.path.isdir(path):
        raise UserError(f"Папку не знайдено: {path}")
    return path


def _norm(path):
    return os.path.normcase(os.path.realpath(path))


def _is_inside(path, folder):
    path, folder = _norm(path), _norm(folder)
    return path == folder or path.startswith(folder.rstrip("\\/") + os.sep)


# ------------------------------------------------------------------ стан і налаштування
@eel.expose
def get_state():
    config = ap.load_config()
    base = config["base_dir"]
    if base and os.path.isdir(base):
        ap.ensure_structure(base)       # нові папки (obc_src, додаткові) з'являються і в старих директоріях
    return {
        "config": config,
        "base_exists": bool(base) and os.path.isdir(base),
        "excel_exists": bool(config["excel_path"]) and os.path.isfile(config["excel_path"]),
        "subdirs": list_subdirs(),
        "default_angle": DEFAULT_MAX_ANGLE,
        "structure": {
            "downloaded": ap.DOWNLOADED_DIR,
            "png": ap.PNG_DIR,
            "png_shoes": ap.PNG_SHOES_DIR,
            "png_bc": ap.PNG_BC_DIR,
            "covers": ap.COVERS_DIR,
            "backups": ap.BACKUPS_DIR,
            "bot": ap.BOT_DIR,
            "bad": ap.BAD_DIR,
            "bad_txt": ap.BAD_TXT,
            "child_txt": ap.CHILD_SHOES_TXT,
            "not_found_txt": ap.NOT_FOUND_TXT,
            "obc_src": ap.OBC_SRC_DIR,
            "extra": ap.EXTRA_DIR,
        },
    }


@eel.expose
def list_subdirs():
    base = ap.load_config()["base_dir"]
    if not base or not os.path.isdir(base):
        return []
    return sorted(
        (e.name for e in os.scandir(base) if e.is_dir() and e.name != ap.BACKUPS_DIR),
        key=str.lower,
    )


@eel.expose
def save_settings(values):
    ap.save_config(**{k: v for k, v in values.items() if k in ("api_key", "region", "proxy", "theme")})
    return True


@eel.expose
@operation
def choose_base_dir():
    config = ap.load_config()
    path = _run_dialog(filedialog.askdirectory, **_dialog_kwargs(config["base_dir"]))
    if not path:
        return {"cancelled": True}
    path = os.path.normpath(path)
    ap.save_config(base_dir=path)
    ap.ensure_structure(path)
    return {"path": path}


@eel.expose
@operation
def choose_excel():
    config = ap.load_config()
    start = config["excel_path"] or config["base_dir"]
    path = _run_dialog(
        filedialog.askopenfilename,
        **_dialog_kwargs(start, filetypes=[("Excel", "*.xlsx *.xlsm"), ("Усі файли", "*.*")]),
    )
    if not path:
        return {"cancelled": True}
    path = os.path.normpath(path)
    ap.save_config(excel_path=path)
    return {"path": path}


@eel.expose
@operation
def open_folder(subdir=""):
    path = os.path.join(require_base(), subdir)
    os.makedirs(path, exist_ok=True)
    os.startfile(path)


def _choose_images(subdir, title):
    """subdir — назва підпапки Основної директорії або абсолютний шлях; '' — сама Основна директорія."""
    start = base_sub(subdir) if subdir else require_base()
    os.makedirs(start, exist_ok=True)
    paths = _run_dialog(
        filedialog.askopenfilenames,
        initialdir=start,
        title=title,
        filetypes=[("Зображення", " ".join(f"*{e}" for e in sorted(IMAGE_EXTENSIONS))), ("Усі файли", "*.*")],
    )
    return [os.path.normpath(p) for p in paths] if paths else []


# ------------------------------------------------------------------ Step 3: завантаження
SEARCH_CHUNK = 100       # артикулів в одному запиті до serper.dev
DOWNLOAD_WORKERS = 16    # паралельних завантажень фото

def _find_bot_dir(base):
    """Папка «бот» (або «bot») в Основній директорії, регістр не важливий."""
    names = {ap.BOT_DIR.casefold(), "bot"}
    for entry in os.scandir(base):
        if entry.is_dir() and entry.name.strip().casefold() in names:
            return entry.path
    return None


@eel.expose
@operation
def download_images(api_key, region):
    base = require_base()
    excel = require_excel()
    if not api_key:
        raise UserError("Вкажіть API ключ serper.dev.")
    ap.save_config(api_key=api_key, region=region)
    proxy = ap.load_config()["proxy"] or None
    region = region or None

    Progress.set(1, "Читаю Excel...")
    images_root = ensure_dir(os.path.join(base, ap.DOWNLOADED_DIR))

    items = []
    for row in read_excel_rows(excel, "Шаблон"):
        code = cell_text(row[0])
        if not code:
            continue
        items.append({
            "code": code,
            "name": cell_text(row[2]),
            "prod_type": cell_text(row[5]),
            "prod_gender": cell_text(row[7]),
            "prod_brand": cell_text(row[9]),
        })
    if not items:
        raise UserError("На листі 'Шаблон' немає артикулів.")

    bot_dir = _find_bot_dir(base)
    skipped = 0
    if bot_dir:
        in_bot = {e.name.strip().casefold() for e in os.scandir(bot_dir) if e.is_dir()}
        before = len(items)
        items = [it for it in items if it["code"].casefold() not in in_bot]
        skipped = before - len(items)
    if not items:
        raise UserError(f"Усі артикули вже є в папці «{ap.BOT_DIR}», парсити нічого.")

    # 1) Пошук: API відповідає швидко, збираємо всі посилання на фото.
    search = Progress(math.ceil(len(items) / SEARCH_CHUNK), start=3, end=15)
    by_code = {it["code"]: it for it in items}
    jobs, errors = [], 0
    for i in range(0, len(items), SEARCH_CHUNK):
        chunk = items[i:i + SEARCH_CHUNK]
        search.step(f"Пошук фото: {min(i + SEARCH_CHUNK, len(items))} з {len(items)}")
        resp_data = json.loads(req(generate_params(chunk, region), api_key))
        for item in resp_data:
            try:
                code = item["searchParameters"]["q"].split(" ")[0]
                descr = by_code.get(code) or search_in_data(code, items) or {}
                target = os.path.join(images_root, code)
                for img in item.get("images", []):
                    w, h = img["imageWidth"], img["imageHeight"]
                    if w < 351 and h < 351:
                        continue
                    uid = f"{random.randint(0, 999):03d}"
                    name = (f"{img['position']}___{code}___{w}x{h}__{descr.get('prod_type')}"
                            f"__{descr.get('prod_brand')}__{region}__{uid}")
                    jobs.append((code, img["imageUrl"], target, name))
            except Exception as e:
                errors += 1
                print(f"Помилка для {item.get('searchParameters')}: {e}")

    # 2) Завантаження паралельно. Потоки качають, а головний greenlet Eel лише
    #    чекає з короткими паузами, щоб інтерфейс і прогрес не зависали.
    progress = Progress(len(jobs), start=15, end=99)
    downloaded = 0
    with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
        pending = {pool.submit(download_image, url, target, name, proxy): code
                   for code, url, target, name in jobs}
        while pending:
            done, _ = wait(pending, timeout=0.2, return_when=FIRST_COMPLETED)
            for future in done:
                code = pending.pop(future)
                try:
                    if future.result():
                        downloaded += 1
                except Exception as e:
                    errors += 1
                    print(f"Помилка завантаження для {code}: {e}")
                progress.step(f"Завантажено {progress.done + 1} з {len(jobs)} ({code})")
            eel.sleep(0)

    progress.finish("Готово")
    msg = f"Завантажено {downloaded} зображень для {len(items)} артикулів"
    if skipped:
        msg += f", пропущено (є в «{ap.BOT_DIR}»): {skipped}"
    elif not bot_dir:
        msg += f". Папку «{ap.BOT_DIR}» не знайдено, парсились усі артикули"
    if errors:
        msg += f", помилок: {errors}"
    return {"message": msg}


# ------------------------------------------------------------------ списки / формат
def _image_names(root_dir):
    """Назви зображень у папці (рекурсивно). З 'pos___CODE___...' береться CODE."""
    result = set()
    for path in Path(root_dir).rglob("*"):
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        name = path.stem
        if "___" in name:
            name = name.split("___")[1]
        result.add(name)
    return result


@eel.expose
@operation
def generate_not_found_list(subdir):
    base = require_base()
    folder = _resolve_subdir(subdir)
    codes = [cell_text(r[0]) for r in read_excel_rows(require_excel(), "Шаблон")]
    found = _image_names(folder)
    not_found = [c for c in codes if c and c not in found]
    out = os.path.join(base, ap.NOT_FOUND_TXT)
    write_lines(out, not_found)
    return {"message": f"Не знайдено {len(not_found)} з {len([c for c in codes if c])}. Список: {ap.NOT_FOUND_TXT}"}


@eel.expose
@operation
def change_ext(subdir):
    folder = _resolve_subdir(subdir)
    files = [p for p in Path(folder).rglob("*")
             if p.is_file() and p.suffix.lower() in {".png", ".webp", ".jfif"}]
    if not files:
        return {"message": "Немає файлів .png / .webp / .jfif для конвертації"}

    progress = Progress(len(files))
    converted, failed = 0, 0
    for file in files:
        progress.step(file.name)
        try:
            with Image.open(file) as img:
                if img.mode in ("RGBA", "LA", "P"):
                    rgba = img.convert("RGBA")
                    background = Image.new("RGB", rgba.size, (255, 255, 255))
                    background.paste(rgba, mask=rgba.split()[-1])
                else:
                    background = img.convert("RGB")
                background.save(file.with_suffix(".jpg"), "JPEG", quality=95)
            file.unlink()
            converted += 1
        except Exception as e:
            failed += 1
            print(f"✗ {file.name}: {e}")
    progress.finish()
    return {"message": f"Сконвертовано у JPG: {converted}" + (f", помилок: {failed}" if failed else "")}


@eel.expose
@operation
def rename(subdir):
    folder = _resolve_subdir(subdir)
    renamed = 0
    for file in Path(folder).iterdir():
        if not file.is_file() or "___" not in file.stem:
            continue
        new_path = file.with_name(file.stem.split("___")[1] + file.suffix)
        try:
            file.rename(new_path)
            renamed += 1
        except Exception as e:
            print(f"✗ {file.name}: {e}")
    return {"message": f"Перейменовано файлів: {renamed}"}


@eel.expose
@operation
def rename_bot(subdir):
    """«КОД-щось-1.jpg» → «КОД-щось.jpg»: відкидається останній фрагмент після «-»."""
    folder = _resolve_subdir(subdir)
    renamed, skipped = 0, 0
    for file in Path(folder).iterdir():
        if not file.is_file() or file.suffix.lower() not in IMAGE_EXTENSIONS or "-" not in file.stem:
            continue
        new_stem = "-".join(file.stem.split("-")[:-1])
        new_path = file.with_name(new_stem + file.suffix)
        if not new_stem or new_path.exists():
            skipped += 1
            continue
        try:
            file.rename(new_path)
            renamed += 1
        except Exception as e:
            skipped += 1
            print(f"✗ {file.name}: {e}")
    msg = f"Перейменовано файлів: {renamed}"
    if skipped:
        msg += f". Пропущено (така назва вже існує або помилка): {skipped}"
    return {"message": msg}


@eel.expose
@operation
def underscores_to_dashes(subdir):
    """«КОД_назва__1.jpg» → «КОД-назва-1.jpg»: назва ділиться по «_» і з'єднується через «-». Рекурсивно."""
    folder = _resolve_subdir(subdir)
    files = [p for p in Path(folder).rglob("*") if p.is_file() and "_" in p.stem]
    renamed, skipped = 0, 0
    for file in files:
        new_stem = "-".join(part for part in file.stem.split("_") if part)
        new_path = file.with_name(new_stem + file.suffix)
        if not new_stem or new_path == file:
            continue
        if new_path.exists():
            skipped += 1
            continue
        try:
            file.rename(new_path)
            renamed += 1
        except Exception as e:
            skipped += 1
            print(f"✗ {file}: {e}")
    msg = f"Перейменовано файлів: {renamed}"
    if skipped:
        msg += f". Пропущено (така назва вже існує або помилка): {skipped}"
    return {"message": msg}


# ------------------------------------------------------------------ Step 4: групування, дзеркало
@eel.expose
@operation
def choose_group_dir():
    path = _run_dialog(filedialog.askdirectory, **_dialog_kwargs(base_sub(ap.DOWNLOADED_DIR)))
    return {"path": os.path.normpath(path)} if path else {"cancelled": True}


@eel.expose
@operation
def group_images(path):
    if not path or not os.path.isdir(path):
        raise UserError("Виберіть папку для групування.")
    input_path = Path(path)
    files = sorted(f for f in input_path.iterdir() if f.is_file())
    if not files:
        raise UserError("У папці немає файлів.")

    group_count = math.ceil(len(files) / 3)
    progress = Progress(group_count)
    for i in range(group_count):
        group_folder = input_path / f"group_{i + 1}"
        group_folder.mkdir(exist_ok=True)
        for file in files[i * 3:(i + 1) * 3]:
            file.rename(group_folder / file.name)
        progress.step()
    progress.finish()
    return {"message": f"Створено груп: {group_count}"}


@eel.expose
@operation
def mirroring():
    paths = _run_dialog(
        filedialog.askopenfilenames, **_dialog_kwargs(require_base(), title="Файли для відзеркалення")
    )
    if not paths:
        return {"cancelled": True}
    progress = Progress(len(paths))
    for path in paths:
        progress.step(os.path.basename(path))
        with Image.open(path) as img:
            flipped = img.transpose(Image.FLIP_LEFT_RIGHT)
        flipped.save(path)
    progress.finish()
    return {"message": f"Відзеркалено: {len(paths)}"}


@eel.expose
@operation
def pick_shoes():
    files = _choose_images("", "Виберіть взуття (буде переміщено в png_shoes)")
    if not files:
        return {"cancelled": True}
    target = base_sub(ap.PNG_SHOES_DIR)
    for file in files:
        move_file(file, os.path.join(target, os.path.basename(file)))
    return {"message": f"Переміщено в {ap.PNG_SHOES_DIR}: {len(files)}"}


@eel.expose
@operation
def move_bad():
    """Артикули з bad.txt шукаються в png_bc/ і переносяться в bad/."""
    base = require_base()
    candidates = [os.path.join(base, n) for n in (ap.BAD_TXT, "bad")]
    list_path = next((p for p in candidates if os.path.isfile(p)), None)
    if not list_path:
        raise UserError(f"Файл {ap.BAD_TXT} не знайдено в Основній директорії.")
    codes = read_lines(list_path)
    if not codes:
        raise UserError(f"Список {ap.BAD_TXT} порожній.")

    by_name = {}
    for file in list_images(os.path.join(base, ap.PNG_BC_DIR)):
        by_name.setdefault(Path(file).stem.casefold(), []).append(file)

    target = ensure_dir(os.path.join(base, ap.BAD_DIR))
    moved, missing = 0, []
    for code in codes:
        files = by_name.pop(code.casefold(), None)
        if not files:
            missing.append(code)
            continue
        for file in files:
            move_file(file, os.path.join(target, os.path.basename(file)))
            moved += 1
    msg = f"Переміщено в {ap.BAD_DIR}: {moved}"
    if missing:
        write_lines(os.path.join(base, "bad_not_found.txt"), missing)
        msg += f". Не знайдено в {ap.PNG_BC_DIR}: {len(missing)} (bad_not_found.txt)"
    return {"message": msg}


# ------------------------------------------------------------------ обкладинки
def _generate_covers(files, make_cover, dst_dir):
    covers = _resolve_subdir(dst_dir)
    png_bc = ensure_dir(base_sub(ap.PNG_BC_DIR))
    progress = Progress(len(files))
    done, failed = 0, []
    for file in files:
        name = Path(file).stem
        progress.step(name)
        try:
            make_cover(file, os.path.join(covers, f"{name}.jpg"))
            if not _is_inside(file, png_bc):  # файл уже в png_bc — не переміщуємо сам у себе
                move_file(file, os.path.join(png_bc, os.path.basename(file)))
            done += 1
        except Exception as e:
            failed.append(name)
            print(f"✗ {file}: {e}")
    progress.finish()
    msg = f"Створено обкладинок: {done} → {os.path.basename(covers)}, PNG переміщено в {ap.PNG_BC_DIR}"
    if failed:
        msg += f". Помилки: {', '.join(failed[:10])}"
    return {"message": msg}


def _parse_angle(value):
    try:
        angle = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return DEFAULT_MAX_ANGLE
    return min(max(angle, 0.0), 45.0)


@eel.expose
@operation
def covers_clothes(with_models, src_dir=ap.PNG_DIR, dst_dir=ap.COVERS_DIR):
    title = "Одяг з моделями" if with_models else "Одяг без моделей"
    files = _choose_images(_resolve_subdir(src_dir), f"{title}: виберіть PNG")
    if not files:
        return {"cancelled": True}
    return _generate_covers(
        files, lambda src, dst: create_cover_other(src, dst, with_padding=not with_models), dst_dir
    )


@eel.expose
@operation
def covers_shoes(max_angle, src_dir=ap.PNG_SHOES_DIR, dst_dir=ap.COVERS_DIR):
    angle = _parse_angle(max_angle)
    files = _choose_images(_resolve_subdir(src_dir), "Взуття: виберіть PNG")
    if not files:
        return {"cancelled": True}
    return _generate_covers(
        files, lambda src, dst: create_cover_with_background(src, dst, ap.BG_IMAGE, angle), dst_dir
    )


# ------------------------------------------------------------------ дитяче взуття
def _norm_text(value):
    return cell_text(value).casefold()


def build_child_shoes_codes(excel_path):
    """
    Шаблон: рядки з H == 'Детский'.
    Справочник: filtred = значення A, де B == 'Взуття'.
    Результат: A з Шаблону для рядків, у яких F входить у filtred.
    """
    filtred = {
        _norm_text(row[0])
        for row in read_excel_rows(excel_path, "Справочник")
        if len(row) > 1 and _norm_text(row[1]) == "взуття" and _norm_text(row[0])
    }
    codes = []
    for row in read_excel_rows(excel_path, "Шаблон"):
        if len(row) < 8 or _norm_text(row[7]) != "детский":
            continue
        if _norm_text(row[5]) in filtred:
            code = cell_text(row[0])
            if code:
                codes.append(code)
    return codes


@eel.expose
@operation
def build_child_list():
    codes = build_child_shoes_codes(require_excel())
    write_lines(base_sub(ap.CHILD_SHOES_TXT), codes)
    return {"message": f"Дитяче взуття: {len(codes)} артикулів → {ap.CHILD_SHOES_TXT}"}


@eel.expose
@operation
def covers_child(max_angle, src_dir=ap.PNG_BC_DIR, dst_dir=ap.COVERS_DIR):
    angle = _parse_angle(max_angle)
    src = _resolve_subdir(src_dir)
    covers = _resolve_subdir(dst_dir)
    list_path = base_sub(ap.CHILD_SHOES_TXT)
    if not os.path.isfile(list_path):
        write_lines(list_path, build_child_shoes_codes(require_excel()))
    codes = read_lines(list_path)
    if not codes:
        raise UserError(f"Список {ap.CHILD_SHOES_TXT} порожній.")

    by_name = {}
    for file in list_images(src):
        by_name.setdefault(Path(file).stem.casefold(), file)

    src_name = os.path.basename(src)
    matched = [(code, by_name[code.casefold()]) for code in codes if code.casefold() in by_name]
    missing = [code for code in codes if code.casefold() not in by_name]
    if not matched:
        raise UserError(f"У {src_name} не знайдено жодного файлу з {ap.CHILD_SHOES_TXT}.")

    progress = Progress(len(matched))
    done = 0
    for code, file in matched:
        progress.step(code)
        try:
            create_child_shoes_cover(file, os.path.join(covers, f"{Path(file).stem}.jpg"), ap.BG_IMAGE, angle)
            done += 1
        except Exception as e:
            print(f"✗ {file}: {e}")
    progress.finish()

    msg = f"Дитячих обкладинок: {done} → {os.path.basename(covers)}"
    if missing:
        write_lines(base_sub("child_shoes_not_found.txt"), missing)
        msg += f". Немає в {src_name}: {len(missing)} (child_shoes_not_found.txt)"
    return {"message": msg}


# ------------------------------------------------------------------ відбір фото (галерея)
THUMB_WORKERS = 8
_THUMB_CACHE_MAX = 4000
_thumb_cache = OrderedDict()            # (шлях, mtime, size, box) -> data URL
_thumb_lock = threading.Lock()
_thumb_pool = ThreadPoolExecutor(max_workers=THUMB_WORKERS)

# Поточний стан галереї: папка-джерело і активна директорія (артикул).
gallery_state = {"source": "", "active": ""}


def _gallery_root(source):
    return _resolve_subdir(source)


@eel.expose
@operation
def gallery_dirs(source):
    """Директорії всередині вибраної папки — по них ходить пагінація."""
    root = _gallery_root(source)
    gallery_state["source"] = source
    dirs = sorted((e.name for e in os.scandir(root) if e.is_dir()), key=str.lower)
    return {"dirs": dirs}


@eel.expose
@operation
def gallery_images(source, name):
    """Імена зображень в активній директорії."""
    folder = os.path.join(_gallery_root(source), name)
    if not os.path.isdir(folder):
        raise UserError(f"Папку не знайдено: {folder}")
    gallery_state["source"], gallery_state["active"] = source, name
    files = [os.path.basename(p) for p in list_images(folder)]
    files.sort(key=str.lower)
    return {"files": files, "sizes": {f: _image_size(os.path.join(folder, f)) for f in files}}


def _image_size(path):
    """[ширина, висота] з урахуванням EXIF-орієнтації; читає лише заголовок файлу."""
    try:
        with Image.open(path) as im:
            w, h = im.size
            if im.getexif().get(0x0112) in (5, 6, 7, 8):
                w, h = h, w
            return [w, h]
    except Exception:
        return None


def _render_thumb(path, box):
    """Зменшена копія як data URL (WEBP з альфою). Не збільшує — лише зменшує."""
    st = os.stat(path)
    key = (path, st.st_mtime_ns, st.st_size, box)
    with _thumb_lock:
        cached = _thumb_cache.get(key)
        if cached:
            _thumb_cache.move_to_end(key)
            return cached

    with Image.open(path) as im:
        im.draft("RGB", (box, box))         # JPEG: швидке декодування одразу в меншому розмірі
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if im.mode in ("P", "LA", "PA") or "transparency" in im.info else "RGB")
        im.thumbnail((box, box), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=90, method=4)
    url = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")

    with _thumb_lock:
        _thumb_cache[key] = url
        while len(_thumb_cache) > _THUMB_CACHE_MAX:
            _thumb_cache.popitem(last=False)
    return url


@eel.expose
def gallery_thumbs(source, name, files, box):
    """Мініатюри пачкою: {файл: data URL | None}. box — розмір у пікселях (з урахуванням DPI)."""
    try:
        folder = os.path.join(_gallery_root(source), name)
    except UserError:
        return {}
    box = max(32, min(int(box), 800))
    futures = {f: _thumb_pool.submit(_render_thumb, os.path.join(folder, f), box) for f in files}
    # потоки рендерять, головний greenlet Eel не блокується
    while not all(fut.done() for fut in futures.values()):
        eel.sleep(0.01)
    result = {}
    for f, fut in futures.items():
        try:
            result[f] = fut.result()
        except Exception as e:
            print(f"✗ мініатюра {f}: {e}")
            result[f] = None
    return result


# ---------- редактор фото (обрізка / нахил) — перезаписує оригінал з тією ж назвою
_SAVE_FORMATS = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP",
                 ".bmp": "BMP", ".tif": "TIFF", ".tiff": "TIFF"}


def _gallery_file(source, name, file):
    path = os.path.join(_gallery_root(source), os.path.basename(name), os.path.basename(file))
    if not os.path.isfile(path):
        raise UserError(f"Файл не знайдено: {path}")
    return path


def _has_alpha(im):
    return im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)


def _editable(im):
    """Орієнтація з EXIF + режим, з яким працюють rotate/crop і збереження."""
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "RGBA", "L"):
        im = im.convert("RGBA" if _has_alpha(im) else "RGB")
    return im


@eel.expose
@operation
def editor_open(source, name, file, box):
    """Прев'ю для редактора (до box px) + реальний розмір оригіналу."""
    path = _gallery_file(source, name, file)
    box = max(200, min(int(box), 3000))
    with Image.open(path) as src:
        alpha = _has_alpha(src)
        im = _editable(src)
    width, height = im.size
    im.thumbnail((box, box), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=92, method=4)
    url = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    return {"url": url, "width": width, "height": height, "alpha": alpha}


@eel.expose
@operation
def editor_save(source, name, file, quarter, angle, crop):
    """
    quarter — повороти на 90° за годинниковою; angle — нахил у градусах (за годинниковою);
    crop — [x, y, w, h] у частках від повернутого кадру (з розширенням під кути).
    """
    path = _gallery_file(source, name, file)
    fmt = _SAVE_FORMATS.get(Path(path).suffix.lower())
    if not fmt:
        raise UserError(f"Формат не підтримується для збереження: {Path(path).suffix}")

    with Image.open(path) as src:
        alpha = _has_alpha(src)
        info = {k: src.info[k] for k in ("icc_profile", "dpi") if k in src.info}
        im = _editable(src)
    if alpha and im.mode != "RGBA":
        im = im.convert("RGBA")

    quarter = int(quarter) % 4
    if quarter:
        im = im.transpose({1: Image.ROTATE_270, 2: Image.ROTATE_180, 3: Image.ROTATE_90}[quarter])
    angle = float(angle)
    if abs(angle) > 0.01:
        fill = (0, 0, 0, 0) if im.mode == "RGBA" else (255 if im.mode == "L" else (255, 255, 255))
        im = im.rotate(-angle, resample=Image.BICUBIC, expand=True, fillcolor=fill)

    x, y, w, h = (min(1.0, max(0.0, float(v))) for v in crop)
    W, H = im.size
    left, top = round(x * W), round(y * H)
    right, bottom = min(W, round((x + w) * W)), min(H, round((y + h) * H))
    if right - left < 2 or bottom - top < 2:
        raise UserError("Занадто мала область обрізки.")
    if (left, top, right, bottom) != (0, 0, W, H):
        im = im.crop((left, top, right, bottom))

    if fmt == "JPEG":
        if im.mode == "RGBA":
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            im = bg
        info.update(quality=95, subsampling=0, optimize=True)
    elif fmt == "WEBP":
        info.update(quality=95, method=4)

    _undo_push(path)
    tmp = path + ".tmp"
    try:
        im.save(tmp, fmt, **info)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"message": f"Збережено: {os.path.basename(path)} ({im.width}×{im.height})",
            "width": im.width, "height": im.height, "undo": len(_undo_stack.get(path, ()))}


# Попередні версії перезаписаних файлів (на час роботи програми) — для «Відмінити».
_UNDO_MAX = 20
_undo_dir = None
_undo_stack = {}                        # шлях -> [копії, від старої до нової]
_undo_seq = itertools.count()


def _undo_push(path):
    global _undo_dir
    if _undo_dir is None:
        _undo_dir = tempfile.mkdtemp(prefix="yjb_undo_")
        atexit.register(shutil.rmtree, _undo_dir, True)
    stack = _undo_stack.setdefault(path, [])
    copy = os.path.join(_undo_dir, f"{next(_undo_seq)}{Path(path).suffix}")
    shutil.copy2(path, copy)
    stack.append(copy)
    if len(stack) > _UNDO_MAX:
        os.unlink(stack.pop(0))


@eel.expose
@operation
def editor_undo(source, name, file):
    """Повертає попередню версію файлу, перезаписаного редактором."""
    path = _gallery_file(source, name, file)
    stack = _undo_stack.get(path)
    if not stack:
        raise UserError("Немає що відміняти.")
    os.replace(stack.pop(), path)
    size = _image_size(path) or [0, 0]
    return {"message": f"Відмінено: {os.path.basename(path)}", "undo": len(stack),
            "width": size[0], "height": size[1]}


@eel.expose
@operation
def gallery_apply(source, selection):
    """
    selection: {директорія: {"main": файл | None, "extra": [файли]}}.
    Основне фото → obc_src/<директорія><розширення> (старе з такою ж назвою замінюється).
    Додаткові → додаткові/<директорія>/<файл>.
    """
    base = require_base()
    root = _gallery_root(source)
    obc = ensure_dir(os.path.join(base, ap.OBC_SRC_DIR))
    extra_root = ensure_dir(os.path.join(base, ap.EXTRA_DIR))
    if _is_inside(root, obc) or _is_inside(root, extra_root):
        raise UserError(f"Папка-джерело не може бути {ap.OBC_SRC_DIR} або {ap.EXTRA_DIR}.")

    jobs = []  # (директорія, вид, шлях-джерело)
    for name, sel in selection.items():
        name = os.path.basename(name)
        folder = os.path.join(root, name)
        if sel.get("main"):
            jobs.append((name, "main", os.path.join(folder, os.path.basename(sel["main"]))))
        for file in sel.get("extra") or []:
            jobs.append((name, "extra", os.path.join(folder, os.path.basename(file))))
    if not jobs:
        raise UserError("Нічого не вибрано.")

    obc_by_stem = {}
    for file in list_images(obc):
        obc_by_stem.setdefault(Path(file).stem.casefold(), []).append(file)

    progress = Progress(len(jobs))
    mains, extras, done_dirs, failed = 0, 0, set(), []
    for name, kind, src in jobs:
        progress.step(f"{name}: {os.path.basename(src)}")
        try:
            if not os.path.isfile(src):
                raise FileNotFoundError(src)
            if kind == "main":
                for old in obc_by_stem.pop(name.casefold(), []):
                    os.unlink(old)       # попереднє основне фото цього артикулу (будь-яке розширення)
                move_file(src, os.path.join(obc, name + Path(src).suffix.lower()))
                mains += 1
            else:
                move_file(src, os.path.join(extra_root, name, os.path.basename(src)))
                extras += 1
            done_dirs.add(name)
        except Exception as e:
            failed.append(f"{name}/{os.path.basename(src)}")
            print(f"✗ {src}: {e}")
    progress.finish()

    msg = f"Перенесено: основних {mains} → {ap.OBC_SRC_DIR}, додаткових {extras} → {ap.EXTRA_DIR}"
    if failed:
        msg += f". Не вдалося: {', '.join(failed[:10])}" + (" …" if len(failed) > 10 else "")
    return {"message": msg, "done": sorted(done_dirs), "failed": failed}


# ------------------------------------------------------------------ пакування
_STORED_EXT = IMAGE_EXTENSIONS | {".zip", ".xlsx", ".xlsm"}   # уже стиснуті — не тиснемо вдруге


def _zip_folder(folder, zip_path, progress):
    """Пакує папку в zip разом з нею самою як коренем архіву."""
    files = [p for p in Path(folder).rglob("*") if p.is_file()]
    parent = Path(folder).parent
    tmp = zip_path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        zf.write(folder, Path(folder).name)          # запис самої папки — щоб була і порожня
        for p in files:
            ctype = zipfile.ZIP_STORED if p.suffix.lower() in _STORED_EXT else zipfile.ZIP_DEFLATED
            zf.write(p, p.relative_to(parent).as_posix(), compress_type=ctype)
            progress.step(f"{os.path.basename(zip_path)}: {p.name}")
    os.replace(tmp, zip_path)
    return len(files)


@eel.expose
@operation
def pack_archives():
    """
    1) <Основна>/<назва Основної>/: Excel + усі папки з «додаткові» → <назва Основної>.zip
    2) «обкладинки» → обкладинки.zip
    Архіви лягають в Основну директорію; наявні перезаписуються.
    """
    base = require_base()
    excel = require_excel()
    name = os.path.basename(os.path.normpath(base))
    extra = os.path.join(base, ap.EXTRA_DIR)
    covers = os.path.join(base, ap.COVERS_DIR)

    extra_dirs = sorted(e.path for e in os.scandir(extra) if e.is_dir()) if os.path.isdir(extra) else []
    if not extra_dirs:
        raise UserError(f"У папці «{ap.EXTRA_DIR}» немає жодної папки.")
    if not os.path.isdir(covers) or not any(Path(covers).rglob("*")):
        raise UserError(f"Папка «{ap.COVERS_DIR}» порожня.")

    if name.casefold() in {s.casefold() for s in ap.STRUCTURE + [ap.BACKUPS_DIR]}:
        raise UserError(f"Основна директорія називається як робоча папка «{name}» — пакування скасовано.")

    Progress.set(2, f"Збираю папку {name}...")
    pack_dir = os.path.join(base, name)
    if os.path.isdir(pack_dir):
        shutil.rmtree(pack_dir)                  # збирається заново щоразу
    os.makedirs(pack_dir)
    shutil.copy2(excel, os.path.join(pack_dir, os.path.basename(excel)))
    for d in extra_dirs:
        shutil.copytree(d, os.path.join(pack_dir, os.path.basename(d)))

    total = sum(1 for p in Path(pack_dir).rglob("*") if p.is_file()) + \
        sum(1 for p in Path(covers).rglob("*") if p.is_file())
    progress = Progress(total, start=10, end=99)
    n_pack = _zip_folder(pack_dir, os.path.join(base, f"{name}.zip"), progress)
    n_covers = _zip_folder(covers, os.path.join(base, f"{ap.COVERS_DIR}.zip"), progress)
    progress.finish("Готово")
    return {"message": f"Створено {name}.zip ({n_pack} файлів, папок з «{ap.EXTRA_DIR}»: {len(extra_dirs)}) "
                       f"і {ap.COVERS_DIR}.zip ({n_covers} файлів)"}


# ------------------------------------------------------------------ бекап та очищення
def _check_safe_to_clean(base):
    home = os.path.expanduser("~")
    forbidden = [home, os.path.join(home, "Desktop"), os.path.join(home, "Documents")]
    if os.path.dirname(_norm(base)) == _norm(base):
        raise UserError("Основна директорія — це корінь диска. Очищення заборонено.")
    if any(_norm(base) == _norm(p) for p in forbidden):
        raise UserError("Основна директорія — системна папка користувача. Очищення заборонено.")
    if _is_inside(ap.app_dir(), base):
        raise UserError("У Основній директорії лежить сама програма. Очищення заборонено.")


@eel.expose
@operation
def backup_preview():
    base = require_base()
    _check_safe_to_clean(base)
    items = sorted(e.name for e in os.scandir(base) if e.name != ap.BACKUPS_DIR)
    return {"items": items, "base": base}


@eel.expose
@operation
def backup_and_clean():
    base = require_base()
    _check_safe_to_clean(base)
    excel = ap.load_config()["excel_path"]

    dest = os.path.join(base, ap.BACKUPS_DIR, datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
    os.makedirs(dest)
    Progress.set(5, "Бекап Excel...")
    if excel and os.path.isfile(excel):
        shutil.copy2(excel, os.path.join(dest, os.path.basename(excel)))

    Progress.set(15, f"Бекап {ap.PNG_BC_DIR}...")
    png_bc = os.path.join(base, ap.PNG_BC_DIR)
    if os.path.isdir(png_bc):
        shutil.move(png_bc, os.path.join(dest, ap.PNG_BC_DIR))

    entries = [e for e in os.scandir(base) if e.name != ap.BACKUPS_DIR]
    progress = Progress(len(entries), start=40)
    failed = []
    for entry in entries:
        progress.step(f"Видаляю {entry.name}")
        try:
            if entry.is_dir(follow_symlinks=False):
                shutil.rmtree(entry.path)
            else:
                os.unlink(entry.path)
        except Exception as e:
            failed.append(entry.name)
            print(f"✗ {entry.path}: {e}")

    if excel and _is_inside(excel, base) and not os.path.exists(excel):
        ap.save_config(excel_path="")
    ap.ensure_structure(base)
    progress.finish()

    msg = f"Бекап: {os.path.relpath(dest, base)}. Робочі папки очищено."
    if failed:
        msg += f" Не вдалося видалити: {', '.join(failed)}"
    return {"message": msg}


# ------------------------------------------------------------------ запуск
def _setup_logging():
    """У віконному exe немає консолі — пишемо вивід у лог."""
    if sys.stdout is None or sys.stderr is None:
        log = open(os.path.join(ap.data_dir(), "app.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log
    # консоль Windows може не вміти кирилицю — не падаємо на print()
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")


if __name__ == "__main__":
    _setup_logging()
    eel.init(ap.resource_path("web"), allowed_extensions=[".js", ".html"])
    eel.start(
        "index.html",
        mode="edge",
        port=0,
        size=(1760, 940),
        cmdline_args=["--disable-http-cache", "--window-size=1760,940"],
    )
