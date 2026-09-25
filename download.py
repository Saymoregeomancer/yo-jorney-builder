"""Пошук зображень через google.serper.dev та їх завантаження."""

import http.client
import json
import os
import re
from io import BytesIO

import requests
from PIL import Image


def download_image(url, save_dir, filename, proxy=None):
    """
    Завантажує зображення і зберігає як JPG.
    1. Спочатку без проксі.
    2. Якщо не вдалося і проксі задано — повторює через проксі.
    """
    os.makedirs(save_dir, exist_ok=True)
    proxies = {"http": proxy, "https": proxy} if proxy else None

    def get_image(use_proxy):
        response = requests.get(url, timeout=20, proxies=proxies if use_proxy else None)
        response.raise_for_status()
        img = Image.open(BytesIO(response.content))
        return img.convert("RGB") if img.mode != "RGB" else img

    try:
        img = get_image(False)
    except Exception as first_error:
        if not proxies:
            print(f"Не вдалося завантажити {url}: {first_error}")
            return None
        print(f"Без проксі не вдалося: {first_error}. Повтор через проксі...")
        try:
            img = get_image(True)
        except Exception as second_error:
            print(f"Через проксі теж не вдалося: {second_error}")
            return None

    save_path = os.path.join(save_dir, f"{filename}.jpg")
    img.save(save_path, "JPEG", quality=100)
    return save_path


def search_in_data(code, arr):
    for item in arr:
        if code == item["code"]:
            return item
    return None


def generate_params(arr, region=None):
    resp = []
    for item in arr:
        temp = {"q": f"{item['code']} {item['name']}"}
        if region:
            temp["gl"] = str(region)
        resp.append(temp)
    return resp


def normalize_filename(name):
    name = re.sub(r'[\\/:*?"<>|]', "", name)
    name = name.replace(" ", "_").replace("www.", "").replace(".", "_")
    return name[:10]


def req(params, key):
    conn = http.client.HTTPSConnection("google.serper.dev", timeout=60)
    headers = {"X-API-KEY": key, "Content-Type": "application/json"}
    conn.request("POST", "/images", json.dumps(params), headers)
    res = conn.getresponse()
    data = res.read().decode("utf-8")
    if res.status != 200:
        raise RuntimeError(f"serper.dev відповів {res.status}: {data[:200]}")
    return data
