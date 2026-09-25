"""Генерація обкладинок 810x853."""

from pathlib import Path

import cv2
import numpy as np
from PIL import Image

CANVAS_SIZE = (810, 853)
BG_COLOR = (248, 248, 248)          # #f8f8f8

DEFAULT_MAX_ANGLE = 12.0            # макс. відхилення (градуси) при авто-вирівнюванні підошви
SHOES_BOTTOM_MARGIN = 273           # відступ взуття від низу

CHILD_SCALE = 0.64                  # дитяче взуття: зменшення готової обкладинки
CHILD_BOTTOM_MARGIN = 100           # дитяче взуття: відступ від низу


def _save_jpg(image, output_path, quality=100):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output_path, "JPEG", quality=quality, optimize=True, progressive=True)


def _open_trimmed(input_path):
    img = Image.open(input_path).convert("RGBA")
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


# ------------------------------------------------------------------ одяг
def create_cover_other(input_path, output_path, with_padding=True):
    """
    Обкладинка одягу на фоні #f8f8f8.

    with_padding=True  - одяг без моделі: відступ від краю (вписується в 780x835)
    with_padding=False - одяг з моделлю: без відступу, на всю висоту/ширину полотна
    """
    target_w, target_h = (780, 835) if with_padding else CANVAS_SIZE
    max_upscale = 1.3

    img = _open_trimmed(input_path)
    w, h = img.size

    scale = min(target_w / w, target_h / h)
    if scale > 1:
        scale = min(scale, max_upscale)
    img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

    canvas = Image.new("RGB", CANVAS_SIZE, BG_COLOR)
    x = (CANVAS_SIZE[0] - img.width) // 2
    y = (CANVAS_SIZE[1] - img.height) // 2
    canvas.paste(img, (x, y), img)

    _save_jpg(canvas, output_path)


# ------------------------------------------------------------------ взуття
def _rotate(image, angle):
    h, w = image.shape[:2]
    center = (w / 2, h / 2)
    m = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    new_w = int(h * sin + w * cos)
    new_h = int(h * cos + w * sin)
    m[0, 2] += new_w / 2 - center[0]
    m[1, 2] += new_h / 2 - center[1]
    return cv2.warpAffine(
        image, m, (new_w, new_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )


def _bottom_score(rot):
    mask = rot[:, :, 3] > 10
    h = mask.shape[0]
    has_pixels = mask.any(axis=0)
    # найнижчий непрозорий піксель кожної колонки
    ys = (h - 1 - np.argmax(mask[::-1, :], axis=0))[has_pixels].astype(np.float32)
    if len(ys) < 20:
        return None

    ys = ys[int(len(ys) * 0.20):int(len(ys) * 0.80)]
    if len(ys) < 20:
        return None

    ys = cv2.GaussianBlur(ys.reshape(-1, 1), (9, 1), 0).flatten()

    ground = np.percentile(ys, 98)
    contact = np.sum(ground - ys <= 2)
    std = np.std(ys)
    rng = np.max(ys) - np.min(ys)

    best_run, run = 1, 1
    for prev, cur in zip(ys[:-1], ys[1:]):
        run = run + 1 if abs(cur - prev) <= 1 else 1
        best_run = max(best_run, run)

    return contact * 1000 + best_run * 50 - std * 80 - rng * 20


def auto_rotate_bottom(image, max_angle=DEFAULT_MAX_ANGLE):
    """Повертає PNG так, щоб підошва була максимально горизонтальною."""
    img = np.array(image.convert("RGBA"))
    if max_angle <= 0:
        return Image.fromarray(img, "RGBA")

    best_score, best_img = -1e18, img
    for angle in np.arange(-max_angle, max_angle + 0.0001, 0.1):
        rot = _rotate(img, angle)
        score = _bottom_score(rot)
        if score is not None and score > best_score:
            best_score, best_img = score, rot

    return Image.fromarray(best_img, "RGBA")


def build_shoes_cover(input_path, bg_path, max_angle=DEFAULT_MAX_ANGLE):
    """Обкладинка взуття на фоні-картинці (повертає PIL.Image)."""
    target_w = CANVAS_SIZE[0]
    max_upscale = 2.0

    img = Image.open(input_path).convert("RGBA")
    img = auto_rotate_bottom(img, max_angle)
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)

    w, h = img.size
    scale = target_w / w
    if scale > 1:
        scale = min(scale, max_upscale)
    img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

    background = Image.open(bg_path).convert("RGB").resize(CANVAS_SIZE, Image.LANCZOS)

    x = (CANVAS_SIZE[0] - img.width) // 2
    y = max(0, CANVAS_SIZE[1] - SHOES_BOTTOM_MARGIN - img.height)
    background.paste(img, (x, y), img)
    return background


def create_cover_with_background(input_path, output_path, bg_path, max_angle=DEFAULT_MAX_ANGLE):
    _save_jpg(build_shoes_cover(input_path, bg_path, max_angle), output_path)


# ------------------------------------------------------------------ дитяче взуття
def shrink_to_child(cover, scale=CHILD_SCALE, bottom_margin=CHILD_BOTTOM_MARGIN):
    """Зменшує готову обкладинку і ставить її на фон #f8f8f8 з відступом від низу."""
    img = cover.convert("RGBA")
    img = img.resize((int(img.width * scale), int(img.height * scale)), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", CANVAS_SIZE, BG_COLOR + (255,))
    x = (CANVAS_SIZE[0] - img.width) // 2
    y = max(0, CANVAS_SIZE[1] - bottom_margin - img.height)
    canvas.paste(img, (x, y), img)
    return canvas.convert("RGB")


def create_child_shoes_cover(input_path, output_path, bg_path, max_angle=DEFAULT_MAX_ANGLE):
    cover = build_shoes_cover(input_path, bg_path, max_angle)
    _save_jpg(shrink_to_child(cover), output_path, quality=95)
