import functools
import json
import math
import os
import random
import shutil
import sys
import traceback
from datetime import datetime
from pathlib import Path

import eel
import tkinter as tk
from tkinter import filedialog
from PIL import Image

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
            "child_txt": ap.CHILD_SHOES_TXT,
            "not_found_txt": ap.NOT_FOUND_TXT,
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
    start = base_sub(subdir)
    os.makedirs(start, exist_ok=True)
    paths = _run_dialog(
        filedialog.askopenfilenames,
        initialdir=start,
        title=title,
        filetypes=[("Зображення", " ".join(f"*{e}" for e in sorted(IMAGE_EXTENSIONS))), ("Усі файли", "*.*")],
    )
    return [os.path.normpath(p) for p in paths] if paths else []


# ------------------------------------------------------------------ Step 3: завантаження
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

    progress = Progress(len(items), start=3, end=99)
    downloaded, errors = 0, 0
    for i in range(0, len(items), 100):
        chunk = items[i:i + 100]
        resp_data = json.loads(req(generate_params(chunk, region), api_key))

        for item in resp_data:
            try:
                code = item["searchParameters"]["q"].split(" ")[0]
                descr = search_in_data(code, items) or {}
                target = os.path.join(images_root, code)
                progress.step(f"Завантажую {code}")
                for img in item.get("images", []):
                    w, h = img["imageWidth"], img["imageHeight"]
                    if w < 351 and h < 351:
                        continue
                    uid = f"{random.randint(0, 999):03d}"
                    name = (f"{img['position']}___{code}___{w}x{h}__{descr.get('prod_type')}"
                            f"__{descr.get('prod_brand')}__{region}__{uid}")
                    if download_image(img["imageUrl"], target, name, proxy):
                        downloaded += 1
            except Exception as e:
                errors += 1
                print(f"Помилка для {item.get('searchParameters')}: {e}")

    progress.finish("Готово")
    return {"message": f"Завантажено {downloaded} зображень для {len(items)} артикулів"
                       + (f", помилок: {errors}" if errors else "")}


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
        filedialog.askopenfilenames, **_dialog_kwargs(base_sub(ap.DOWNLOADED_DIR), title="Файли для відзеркалення")
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
    files = _choose_images(ap.PNG_DIR, "Виберіть взуття (буде переміщено в png_shoes)")
    if not files:
        return {"cancelled": True}
    target = base_sub(ap.PNG_SHOES_DIR)
    for file in files:
        move_file(file, os.path.join(target, os.path.basename(file)))
    return {"message": f"Переміщено в {ap.PNG_SHOES_DIR}: {len(files)}"}


# ------------------------------------------------------------------ обкладинки
def _generate_covers(files, make_cover):
    covers = base_sub(ap.COVERS_DIR)
    png_bc = base_sub(ap.PNG_BC_DIR)
    progress = Progress(len(files))
    done, failed = 0, []
    for file in files:
        name = Path(file).stem
        progress.step(name)
        try:
            make_cover(file, os.path.join(covers, f"{name}.jpg"))
            move_file(file, os.path.join(png_bc, os.path.basename(file)))
            done += 1
        except Exception as e:
            failed.append(name)
            print(f"✗ {file}: {e}")
    progress.finish()
    msg = f"Створено обкладинок: {done} → {ap.COVERS_DIR}, PNG переміщено в {ap.PNG_BC_DIR}"
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
def covers_clothes(with_models):
    title = "Одяг з моделями" if with_models else "Одяг без моделей"
    files = _choose_images(ap.PNG_DIR, f"{title}: виберіть PNG")
    if not files:
        return {"cancelled": True}
    return _generate_covers(
        files, lambda src, dst: create_cover_other(src, dst, with_padding=not with_models)
    )


@eel.expose
@operation
def covers_shoes(max_angle):
    angle = _parse_angle(max_angle)
    files = _choose_images(ap.PNG_SHOES_DIR, "Взуття: виберіть PNG")
    if not files:
        return {"cancelled": True}
    return _generate_covers(
        files, lambda src, dst: create_cover_with_background(src, dst, ap.BG_IMAGE, angle)
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
def covers_child(max_angle):
    angle = _parse_angle(max_angle)
    list_path = base_sub(ap.CHILD_SHOES_TXT)
    if not os.path.isfile(list_path):
        write_lines(list_path, build_child_shoes_codes(require_excel()))
    codes = read_lines(list_path)
    if not codes:
        raise UserError(f"Список {ap.CHILD_SHOES_TXT} порожній.")

    by_name = {}
    for file in list_images(base_sub(ap.PNG_BC_DIR)):
        by_name.setdefault(Path(file).stem.casefold(), file)

    matched = [(code, by_name[code.casefold()]) for code in codes if code.casefold() in by_name]
    missing = [code for code in codes if code.casefold() not in by_name]
    if not matched:
        raise UserError(f"У {ap.PNG_BC_DIR} не знайдено жодного файлу з {ap.CHILD_SHOES_TXT}.")

    covers = base_sub(ap.COVERS_DIR)
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

    msg = f"Дитячих обкладинок: {done} → {ap.COVERS_DIR}"
    if missing:
        write_lines(base_sub("child_shoes_not_found.txt"), missing)
        msg += f". Немає в {ap.PNG_BC_DIR}: {len(missing)} (child_shoes_not_found.txt)"
    return {"message": msg}


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
        size=(1200, 900),
        cmdline_args=["--disable-http-cache", "--window-size=1200,900"],
    )
