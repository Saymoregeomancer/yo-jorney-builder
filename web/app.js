// Eel: eel.fn(args) повертає обгортку; eel.fn(args)() — проміс з результатом Python.

let state = { config: {}, structure: {}, subdirs: [], default_angle: 12 };
let busy = false;

const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ тема
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("theme", theme); } catch (e) {}
}

$("#themeToggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  eel.save_settings({ theme: next })();
});

// ------------------------------------------------------------------ стан
async function refreshState() {
  state = await eel.get_state()();
  const c = state.config;

  setPath("#basePath", "#baseField", c.base_dir, state.base_exists);
  setPath("#excelPath", "#excelField", c.excel_path, state.excel_exists);
  const baseName = (c.base_dir || "").split(/[\\/]/).filter(Boolean).pop();
  $("#packName").textContent = (baseName || "<Основна директорія>") + ".zip";

  if (!$("#apiKey").value) $("#apiKey").value = c.api_key || "";
  if (!$("#region").value) $("#region").value = c.region || "";
  if (!$("#proxy").value) $("#proxy").value = c.proxy || "";
  if (!$("#angle").value) setAngle(state.default_angle);

  fillDirSelects();
  if ($("#gallerySrc").value !== gallery.source) galleryLoadSource();
}

function setPath(textSel, fieldSel, value, exists) {
  const el = $(textSel);
  el.textContent = value || "Не вибрано";
  el.title = value || "";
  $(fieldSel).classList.toggle("ok", !!value && exists);
  $(fieldSel).classList.toggle("bad", !!value && !exists);
}

function fillDirSelects() {
  document.querySelectorAll(".dir-select").forEach((select) => {
    const prev = select.value;
    const wanted = state.structure[select.dataset.default] || select.dataset.default;
    select.innerHTML = "";
    if (!state.subdirs.length) {
      select.append(new Option("— немає папок —", ""));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    state.subdirs.forEach((d) => select.append(new Option(d, d)));
    if (state.subdirs.includes(prev)) select.value = prev;
    else if (state.subdirs.includes(wanted)) select.value = wanted;
  });
}

// Список папок перечитується при кожному розкритті селектора.
async function refreshSubdirs() {
  try {
    state.subdirs = await eel.list_subdirs()();
  } catch (e) {
    return;
  }
  fillDirSelects();
}

document.addEventListener("mousedown", async (e) => {
  const select = e.target.closest(".dir-select");
  if (!select || select.disabled || e.button !== 0) return;
  e.preventDefault(); // спершу оновлюємо список, потім відкриваємо
  select.focus();
  await refreshSubdirs();
  if (select.disabled) return;
  try {
    select.showPicker();
  } catch (err) {}
});

document.addEventListener("keydown", (e) => {
  const select = e.target.closest && e.target.closest(".dir-select");
  if (select && (e.key === "F4" || (e.altKey && e.key === "ArrowDown"))) refreshSubdirs();
});

// ------------------------------------------------------------------ виконання дій
function setBusy(value) {
  busy = value;
  document.body.classList.toggle("busy", value);
  document.querySelectorAll("button:not(#themeToggle), select, input").forEach((el) => {
    if (el.closest(".topbar")) return;
    el.disabled = value;
  });
  if (!value) {
    fillDirSelects();
    renderPager();
  }
}

async function run(name, ...args) {
  if (busy) return;
  setBusy(true);
  setStatus("working", "Виконується…");
  setProgress(0);
  try {
    const res = await eel[name](...args)();
    handleResult(res);
    return res;
  } catch (e) {
    handleResult({ ok: false, error: String(e) });
  } finally {
    setBusy(false);
    refreshState();
  }
}

function handleResult(res) {
  if (!res) return;
  if (res.cancelled) {
    setStatus("idle", "Скасовано");
    return;
  }
  if (res.ok) {
    setStatus("ok", res.message || "Готово");
    if (res.message) toast(res.message, "ok");
  } else {
    setStatus("err", res.error);
    toast(res.error, "err");
  }
}

function runWithDir(name, selectId) {
  const dir = $("#" + selectId).value;
  if (!dir) return toast("Немає доступних папок — виберіть Основну директорію", "err");
  run(name, dir);
}

// Обкладинки: папки «з» / «в» беруться з селекторів <prefix>Src / <prefix>Dst.
function runCover(name, prefix, withModels) {
  const src = $("#" + prefix + "Src").value;
  const dst = $("#" + prefix + "Dst").value;
  if (!src || !dst) return toast("Немає доступних папок — виберіть Основну директорію", "err");
  if (name === "covers_clothes") run(name, withModels, src, dst);
  else run(name, $("#angle").value, src, dst);
}

async function chooseBaseDir() {
  await run("choose_base_dir");
}

async function chooseExcel() {
  await run("choose_excel");
}

function openFolder(sub) {
  eel.open_folder(sub)().then((r) => r && !r.ok && toast(r.error, "err"));
}

async function downloadImages() {
  await eel.save_settings({ proxy: $("#proxy").value.trim() })();
  run("download_images", $("#apiKey").value.trim(), $("#region").value.trim());
}

async function chooseGroupDir() {
  if (busy) return;
  const res = await eel.choose_group_dir()();
  if (res && res.ok && res.path) $("#groupPath").value = res.path;
  else if (res && !res.ok) toast(res.error, "err");
}

function groupImages() {
  run("group_images", $("#groupPath").value.trim());
}

// ------------------------------------------------------------------ бекап
let modalResolve = null;

async function backupAndClean() {
  if (busy) return;
  const preview = await eel.backup_preview()();
  if (!preview.ok) return toast(preview.error, "err");

  $("#modalBase").textContent = preview.base;
  const list = $("#modalItems");
  list.innerHTML = "";
  if (!preview.items.length) list.innerHTML = "<li class='muted'>(нічого)</li>";
  preview.items.forEach((name) => {
    const li = document.createElement("li");
    li.textContent = name;
    if (name === state.structure.png_bc) li.classList.add("keep");
    list.append(li);
  });

  $("#modal").hidden = false;
  const confirmed = await new Promise((resolve) => (modalResolve = resolve));
  if (confirmed) run("backup_and_clean");
}

function closeModal(result) {
  $("#modal").hidden = true;
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal").hidden) closeModal(false);
});

// ------------------------------------------------------------------ відхилення
function setAngle(v) {
  $("#angle").value = v;
  $("#angleRange").value = v;
}
function resetAngle() {
  setAngle(state.default_angle);
}
$("#angleRange").addEventListener("input", (e) => ($("#angle").value = e.target.value));
$("#angle").addEventListener("input", (e) => ($("#angleRange").value = e.target.value));

// ------------------------------------------------------------------ збереження полів
["#apiKey", "#region", "#proxy"].forEach((sel) => {
  $(sel).addEventListener("change", () => {
    eel.save_settings({
      api_key: $("#apiKey").value.trim(),
      region: $("#region").value.trim(),
      proxy: $("#proxy").value.trim(),
    })();
  });
});

// ------------------------------------------------------------------ прогрес / статус / тости
eel.expose(setProgress);
function setProgress(percent, text) {
  percent = Math.max(0, Math.min(100, Math.round(percent)));
  $("#progressFill").style.width = percent + "%";
  $("#progressText").textContent = percent + "%";
  $("#progress").classList.toggle("complete", percent === 100);
  if (text) $("#statusText").textContent = text;
}

function setStatus(kind, text) {
  $("#statusDot").className = "status-dot " + kind;
  $("#statusText").textContent = text;
}

function toast(text, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.classList.add("hide"), kind === "err" ? 7000 : 4500);
  setTimeout(() => el.remove(), kind === "err" ? 7600 : 5100);
  el.addEventListener("click", () => el.remove());
}

// ------------------------------------------------------------------ підказки data-tip
const floatingTip = $("#floatingTip");
document.addEventListener("mouseover", (e) => {
  const target = e.target.closest("[data-tip]");
  if (!target) return;
  floatingTip.textContent = target.dataset.tip;
  floatingTip.classList.add("show");
  const r = target.getBoundingClientRect();
  const tw = floatingTip.offsetWidth;
  const th = floatingTip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));
  let top = r.top - th - 10;
  if (top < 10) top = r.bottom + 10;
  floatingTip.style.left = left + "px";
  floatingTip.style.top = top + "px";
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest("[data-tip]")) floatingTip.classList.remove("show");
});

// ------------------------------------------------------------------ відбір фото (галерея)
const THUMB_BOX = 90;      // мініатюра, CSS px
const CAPTION_NAME_MAX = 12; // довші назви під мініатюрою не показуємо (лише розмір)
const THUMB_BATCH = 24;
const THUMB_CACHE_MAX = 3000;

const gallery = {
  source: "",               // папка-джерело (відносно Основної директорії)
  dirs: [],                 // директорії-артикули в джерелі
  index: 0,
  active: "",               // назва активної директорії — потрібна при перенесенні
  files: [],
  sizes: {},                // файл -> [ширина, висота]
  els: new Map(),           // файл -> .thumb активної директорії
  selection: new Map(),     // директорія -> { main: файл | null, extra: Set<файл> }
  token: 0,                 // відсікає застарілі відповіді при швидкому гортанні
};
const thumbCache = new Map(); // "src/dir/file@px" -> data URL

const thumbsBox = $("#thumbs");
const pxBox = (css) => Math.round(css * Math.min(3, Math.max(1, window.devicePixelRatio || 1)));
const cacheKey = (dir, file, px) => `${gallery.source}/${dir}/${file}@${px}`;

function cachePut(key, url) {
  thumbCache.set(key, url);
  if (thumbCache.size > THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value);
}

async function galleryLoadSource() {
  const src = $("#gallerySrc").value;
  if (src !== gallery.source) gallery.selection.clear();
  gallery.source = src;
  gallery.dirs = [];
  if (!src) return galleryShow(0);
  const res = await eel.gallery_dirs(src)();
  if (!res.ok) {
    toast(res.error, "err");
  } else {
    gallery.dirs = res.dirs;
  }
  const keep = gallery.dirs.indexOf(gallery.active);
  galleryShow(keep >= 0 ? keep : 0);
}

function galleryReload() {
  galleryLoadSource();
}

function galleryStep(delta) {
  if (!gallery.dirs.length) return;
  const i = Math.max(0, Math.min(gallery.dirs.length - 1, gallery.index + delta)); // ±Infinity → край
  if (i !== gallery.index) galleryShow(i);
}

async function galleryShow(index) {
  clearTimeout(hoverTimer);
  const token = ++gallery.token;
  thumbQueue.length = 0;
  thumbObserver.disconnect();
  gallery.els.clear();

  if (!gallery.dirs.length) {
    gallery.index = 0;
    gallery.active = "";
    gallery.files = [];
    renderPager();
    thumbsBox.innerHTML = `<div class="thumbs-empty">${gallery.source ? "У папці немає піддиректорій" : "Виберіть папку — тут з'являться фото"}</div>`;
    return;
  }

  gallery.index = index;
  gallery.active = gallery.dirs[index];
  gallery.files = [];
  renderPager(true);

  const res = await eel.gallery_images(gallery.source, gallery.active)();
  if (token !== gallery.token) return;
  if (!res.ok) {
    toast(res.error, "err");
    thumbsBox.innerHTML = `<div class="thumbs-empty">Не вдалося прочитати папку</div>`;
    return;
  }
  gallery.files = res.files;
  gallery.sizes = res.sizes || {};
  renderThumbs();
  renderPager();
}

function renderPager(flip) {
  const n = gallery.dirs.length;
  const name = $("#pagerName");
  name.textContent = gallery.active || "—";
  name.title = gallery.active;
  if (flip) {
    name.classList.remove("flip");
    void name.offsetWidth;
    name.classList.add("flip");
  }
  $("#pagerPos").textContent = n ? `${gallery.index + 1} / ${n}` : "0 / 0";
  $("#pagerFiles").textContent = gallery.active ? `${gallery.files.length} фото` : "";
  $("#pagerTrackFill").style.width = n ? ((gallery.index + 1) / n) * 100 + "%" : "0";
  $("#pagerPrev").disabled = busy || gallery.index <= 0;
  $("#pagerNext").disabled = busy || gallery.index >= n - 1;

  const sel = gallery.selection.get(gallery.active);
  $("#pagerMain").hidden = !(sel && sel.main);
  const extra = $("#pagerExtra");
  extra.hidden = !(sel && sel.extra.size);
  extra.title = sel ? `Додаткових вибрано: ${sel.extra.size}` : "";
  renderSummary();
}

function renderThumbs() {
  const frag = document.createDocumentFragment();
  const px = pxBox(THUMB_BOX);
  for (const file of gallery.files) {
    const el = document.createElement("div");
    el.className = "thumb";
    el.dataset.file = file;
    el.innerHTML = `<div class="pic"><img alt="" decoding="async" /></div><span class="cap"></span><span class="badge"></span>`;
    setCaption(el, file);
    const url = thumbCache.get(cacheKey(gallery.active, file, px));
    if (url) setThumb(el, url);
    else thumbObserver.observe(el);
    gallery.els.set(file, el);
    frag.append(el);
  }
  thumbsBox.replaceChildren(frag);
  thumbsBox.scrollTop = 0;
  if (!gallery.files.length) thumbsBox.innerHTML = `<div class="thumbs-empty">У цій папці немає зображень</div>`;
  paintSelection();
}

function setThumb(el, url) {
  if (!url) return el.classList.add("ready", "broken");
  const img = el.querySelector("img");
  img.onload = () => el.classList.add("ready");
  img.src = url;
}

// Під мініатюрою: назва (без розширення, якщо не довша за CAPTION_NAME_MAX) і розмір у пікселях.
function setCaption(el, file) {
  const size = gallery.sizes[file];
  const sizeText = size ? `${size[0]}×${size[1]}` : "";
  const stem = file.replace(/\.[^.]+$/, "");
  const cap = el.querySelector(".cap");
  cap.replaceChildren();
  if (stem.length <= CAPTION_NAME_MAX) {
    const b = document.createElement("b");
    b.textContent = stem;
    cap.append(b);
  }
  cap.append(sizeText);
  el.title = sizeText ? `${file} — ${sizeText}` : file;
}

// Мініатюри вантажаться лише для видимих (+ запас) плиток, пачками.
const thumbQueue = [];
let thumbTimer = null;
let thumbLoading = false;

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      thumbQueue.push(e.target);
    }
    if (thumbQueue.length && !thumbTimer) thumbTimer = setTimeout(flushThumbs, 16);
  },
  { root: thumbsBox, rootMargin: "300px 0px" }
);

async function flushThumbs() {
  thumbTimer = null;
  if (thumbLoading) return;
  thumbLoading = true;
  try {
    while (thumbQueue.length) {
      const batch = thumbQueue.splice(0, THUMB_BATCH).filter((el) => el.isConnected);
      if (!batch.length) continue;
      const dir = gallery.active;
      const px = pxBox(THUMB_BOX);
      const files = batch.map((el) => el.dataset.file);
      const res = await eel.gallery_thumbs(gallery.source, dir, files, px)();
      for (const file of files) if (file in res) cachePut(cacheKey(dir, file, px), res[file]);
      batch.forEach((el) => el.isConnected && setThumb(el, res[el.dataset.file]));
    }
  } finally {
    thumbLoading = false;
  }
}

// ---------- вибір: ЛКМ — основне (одне), ПКМ — додаткові (кілька)
function selectionFor(dir) {
  let sel = gallery.selection.get(dir);
  if (!sel) gallery.selection.set(dir, (sel = { main: null, extra: new Set() }));
  return sel;
}

function toggleMain(file) {
  const sel = selectionFor(gallery.active);
  if (sel.main === file) sel.main = null;
  else {
    sel.extra.delete(file);
    sel.main = file;
  }
  afterSelect(sel);
}

function toggleExtra(file) {
  const sel = selectionFor(gallery.active);
  if (sel.extra.has(file)) sel.extra.delete(file);
  else {
    if (sel.main === file) sel.main = null;
    sel.extra.add(file);
  }
  afterSelect(sel);
}

function afterSelect(sel) {
  if (!sel.main && !sel.extra.size) gallery.selection.delete(gallery.active);
  paintSelection();
  renderPager();
}

function paintSelection() {
  const sel = gallery.selection.get(gallery.active);
  gallery.els.forEach((el, file) => {
    el.classList.toggle("main", !!sel && sel.main === file);
    el.classList.toggle("extra", !!sel && sel.extra.has(file));
  });
}

function renderSummary() {
  let mains = 0, extras = 0;
  gallery.selection.forEach((s) => {
    if (s.main) mains++;
    extras += s.extra.size;
  });
  $("#selSummary").innerHTML = mains || extras
    ? `Основних: <b class="m">${mains}</b> · додаткових: <b class="e">${extras}</b> · папок: <b>${gallery.selection.size}</b>`
    : "Нічого не вибрано";
}

function galleryClearSelection() {
  if (!gallery.selection.size) return;
  gallery.selection.clear();
  paintSelection();
  renderPager();
}

thumbsBox.addEventListener("click", (e) => {
  const el = e.target.closest(".thumb");
  if (el && !busy) toggleMain(el.dataset.file);
});
thumbsBox.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const el = e.target.closest(".thumb");
  if (el && !busy) toggleExtra(el.dataset.file);
});

// ---------- редактор фото: обрізка / нахил / поворот, збереження поверх оригіналу.
// Один клас на два місця: велике вікно (СКМ по плитці) і панель праворуч (наведення + автозбереження).
class ImageEditor {
  constructor(root, { pad = 28, onChange = null } = {}) {
    const r = (name) => root.querySelector(`[data-r="${name}"]`);
    Object.assign(this, {
      stage: r("stage"), canvas: r("canvas"), cropEl: r("crop"), loading: r("loading"),
      nameEl: r("name"), sizeEl: r("size"), angleEl: r("angle"), angleNumEl: r("angleNum"),
      pad,                    // відступ кадру від країв сцени — щоб було за що хапати рамку
      onChange,               // викликається після кожної зміни користувачем
      source: "", dir: "", file: "",
      img: null,              // прев'ю (зменшене)
      W: 0, H: 0,             // розмір оригіналу
      alpha: false,
      quarter: 0,             // повороти на 90° за годинниковою
      angle: 0,               // нахил, градуси за годинниковою
      crop: [0, 0, 1, 1],     // x, y, w, h — частки від повернутого кадру
      view: { left: 0, top: 0, w: 0, h: 0 }, // де намальований кадр у сцені, CSS px
      saving: false,
      drag: null,
      token: 0,               // відсікає застарілі завантаження
    });
    this.bindAngle();
    this.bindDrag();
    new ResizeObserver(() => this.img && this.layout()).observe(this.stage);
  }

  // Повернутий кадр (у пікселях прев'ю) з розширенням під кути, як у PIL rotate(expand=True).
  frame() {
    const { naturalWidth: iw, naturalHeight: ih } = this.img;
    const [bw, bh] = this.quarter % 2 ? [ih, iw] : [iw, ih];
    const a = (this.angle * Math.PI) / 180;
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    return { iw, ih, bw, bh, FW: bw * c + bh * s, FH: bw * s + bh * c };
  }

  // Найбільший прямокутник з пропорціями фото, що вміщується в нахилене фото — без порожніх кутів.
  autoCrop() {
    const { bw, bh, FW, FH } = this.frame();
    const k = Math.min(bw / FW, bh / FH);
    const w = Math.min(1, (k * bw) / FW), h = Math.min(1, (k * bh) / FH);
    this.crop = [(1 - w) / 2, (1 - h) / 2, w, h];
  }

  dirty() {
    if (!this.img) return false;
    const [x, y, w, h] = this.crop;
    const eps = 0.001;
    return this.quarter % 4 !== 0 || Math.abs(this.angle) > 0.01 ||
      x > eps || y > eps || w < 1 - eps || h < 1 - eps;
  }

  layout() {
    if (!this.img) return;
    const { iw, ih, FW, FH } = this.frame();
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    const k = Math.max(0.01, Math.min((sw - this.pad * 2) / FW, (sh - this.pad * 2) / FH));
    const w = FW * k, h = FH * k;
    this.view = { left: (sw - w) / 2, top: (sh - h) / 2, w, h };

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    Object.assign(this.canvas.style, {
      left: this.view.left + "px", top: this.view.top + "px", width: w + "px", height: h + "px",
    });
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
    if (!this.alpha) {
      ctx.fillStyle = "#fff";         // так само заповнюються кути при збереженні
      ctx.fillRect(0, 0, FW, FH);
    }
    ctx.imageSmoothingQuality = "high";
    ctx.translate(FW / 2, FH / 2);
    ctx.rotate(((this.quarter * 90 + this.angle) * Math.PI) / 180);
    ctx.drawImage(this.img, -iw / 2, -ih / 2, iw, ih);
    this.paintCrop();
  }

  paintCrop() {
    const [x, y, w, h] = this.crop;
    const v = this.view;
    Object.assign(this.cropEl.style, {
      left: v.left + x * v.w + "px", top: v.top + y * v.h + "px",
      width: w * v.w + "px", height: h * v.h + "px",
    });
    const { FW, FH, iw } = this.frame();
    const r = this.W / iw;  // прев'ю → оригінал
    const outW = Math.round(w * FW * r), outH = Math.round(h * FH * r);
    this.sizeEl.textContent = this.dirty() ? `${this.W}×${this.H} → ${outW}×${outH}` : `${this.W}×${this.H}`;
  }

  showLoading(text) {
    this.loading.textContent = text;
    this.loading.hidden = false;
  }

  // quiet: старий кадр лишається на екрані, доки не прийде новий (перечитування після збереження).
  async load(source, dir, file, { quiet = false } = {}) {
    const token = ++this.token;
    Object.assign(this, { source, dir, file, quarter: 0, angle: 0, crop: [0, 0, 1, 1] });
    this.setAngleInputs(0);
    this.nameEl.textContent = file;
    this.nameEl.title = file;
    if (!quiet) {
      this.img = null;
      this.sizeEl.textContent = "";
      this.showLoading("Завантаження…");
      this.cropEl.hidden = true;
      this.canvas.width = this.canvas.height = 0;
    }

    const box = Math.round(Math.max(this.stage.clientWidth, this.stage.clientHeight) * (window.devicePixelRatio || 1));
    const res = await eel.editor_open(source, dir, file, box)();
    if (token !== this.token) return false;
    if (!res.ok) {
      toast(res.error, "err");
      this.img = null;
      this.cropEl.hidden = true;
      this.canvas.width = this.canvas.height = 0;
      this.showLoading("Не вдалося відкрити");
      return false;
    }
    const img = new Image();
    img.src = res.url;
    try {
      await img.decode();
    } catch (e) {}
    if (token !== this.token) return false;
    Object.assign(this, { img, W: res.width, H: res.height, alpha: res.alpha });
    this.loading.hidden = true;
    this.cropEl.hidden = false;
    this.layout();
    return true;
  }

  clear(text = "") {
    this.token++;
    Object.assign(this, { source: "", dir: "", file: "", img: null, drag: null });
    this.nameEl.textContent = "—";
    this.nameEl.title = "";
    this.sizeEl.textContent = "";
    this.cropEl.hidden = true;
    this.canvas.width = this.canvas.height = 0;
    this.setAngleInputs(0);
    if (text) this.showLoading(text);
  }

  async save() {
    this.saving = true;
    this.showLoading("Збереження…");
    try {
      return await eel.editor_save(this.source, this.dir, this.file, this.quarter, this.angle, this.crop)();
    } catch (e) {
      return { ok: false, error: String(e) };
    } finally {
      this.saving = false;
      this.loading.hidden = true;
    }
  }

  changed() {
    this.layout();
    if (this.onChange) this.onChange();
  }

  quarterTurn(delta) {
    if (!this.img || this.saving) return;
    this.quarter = (this.quarter + delta + 4) % 4;
    this.autoCrop();
    this.changed();
  }

  setAngleInputs(v) {
    this.angleEl.value = v;
    this.angleNumEl.value = v;
  }

  setAngle(v) {
    if (!this.img || this.saving) return this.setAngleInputs(this.angle);
    v = Math.max(-45, Math.min(45, Number(v) || 0));
    this.angle = Math.round(v * 10) / 10;
    this.autoCrop();
    this.changed();
  }

  reset() {
    if (!this.img || this.saving) return;
    Object.assign(this, { quarter: 0, angle: 0, crop: [0, 0, 1, 1] });
    this.setAngleInputs(0);
    this.changed();
  }

  bindAngle() {
    this.angleEl.addEventListener("input", (e) => {
      this.angleNumEl.value = e.target.value;
      this.setAngle(e.target.value);
    });
    this.angleEl.addEventListener("dblclick", () => {
      this.setAngleInputs(0);
      this.setAngle(0);
    });
    this.angleNumEl.addEventListener("input", (e) => {
      this.angleEl.value = e.target.value;
      this.setAngle(e.target.value);
    });
  }

  // Перетягування: ручки — краї/кути, всередині рамки — зсув, поза рамкою — нова рамка.
  bindDrag() {
    const stage = this.stage;
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.img || this.saving) return;
      const v = this.view;
      const mode = e.target.dataset.h || (e.target === this.cropEl ? "move" : "new");
      const rect = stage.getBoundingClientRect();
      const px = (e.clientX - rect.left - v.left) / v.w;
      const py = (e.clientY - rect.top - v.top) / v.h;
      this.drag = { mode, sx: e.clientX, sy: e.clientY, start: [...this.crop],
        ax: Math.max(0, Math.min(1, px)), ay: Math.max(0, Math.min(1, py)) };
      stage.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    stage.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      const v = this.view;
      const dx = (e.clientX - d.sx) / v.w, dy = (e.clientY - d.sy) / v.h;
      const minW = 16 / v.w, minH = 16 / v.h;
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
      let [x, y, w, h] = d.start;
      let r = x + w, b = y + h;
      const m = d.mode;

      if (m === "move") {
        x = clamp(x + dx, 0, 1 - w);
        y = clamp(y + dy, 0, 1 - h);
        this.crop = [x, y, w, h];
      } else if (m === "new") {
        const cx = clamp(d.ax + dx, 0, 1), cy = clamp(d.ay + dy, 0, 1);
        this.crop = [Math.min(d.ax, cx), Math.min(d.ay, cy), Math.abs(cx - d.ax), Math.abs(cy - d.ay)];
      } else {
        if (m.includes("w")) x = clamp(x + dx, 0, r - minW);
        if (m.includes("e")) r = clamp(r + dx, x + minW, 1);
        if (m.includes("n")) y = clamp(y + dy, 0, b - minH);
        if (m.includes("s")) b = clamp(b + dy, y + minH, 1);
        this.crop = [x, y, r - x, b - y];
      }
      this.paintCrop();
    });

    const end = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      const [, , w, h] = this.crop;
      if (d.mode === "new" && (w * this.view.w < 16 || h * this.view.h < 16)) {
        this.crop = d.start; // випадковий клік — рамку не чіпаємо
        this.paintCrop();
        return;
      }
      if (this.crop.some((n, i) => n !== d.start[i])) this.changed();
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  }
}

// Після збереження / відміни: нові мініатюри, підпис з розміром, перечитаний кадр у панелі.
async function afterImageSaved(source, dir, file, res) {
  if (source === gallery.source && dir === gallery.active && res.width) {
    gallery.sizes[file] = [res.width, res.height];
    const el = gallery.els.get(file);
    if (el) setCaption(el, file);
  }
  refreshThumb(source, dir, file);
  if (dock.source === source && dock.dir === dir && dock.file === file) {
    await dock.load(source, dir, file, { quiet: true });
  }
}

function refreshThumb(source, dir, file) {
  const prefix = `${source}/${dir}/${file}@`;
  for (const key of [...thumbCache.keys()]) if (key.startsWith(prefix)) thumbCache.delete(key);
  const el = source === gallery.source && dir === gallery.active && gallery.els.get(file);
  if (!el) return;
  el.classList.remove("ready", "broken");
  thumbObserver.observe(el); // видима плитка одразу потрапить у чергу і перемалюється
}

// ---------- велике вікно редактора: СКМ по плитці, збереження при закритті
const modalEditor = new ImageEditor($("#editor"));
let modalOpen = false;

async function editorOpen(file, dir = gallery.active) {
  if (busy || modalOpen) return;
  await dockFlush();
  modalOpen = true;
  $("#editor").hidden = false;
  const ok = await modalEditor.load(gallery.source, dir, file);
  if (!ok && modalOpen && modalEditor.file === file) editorClose(false);
}

async function editorClose(save) {
  if (!modalOpen || modalEditor.saving) return;
  if (save && modalEditor.dirty()) {
    const { source, dir, file } = modalEditor;
    const res = await modalEditor.save();
    if (!res.ok) return toast(res.error, "err"); // правки не губимо — редактор лишається відкритим
    toast(res.message);
    afterImageSaved(source, dir, file, res);
  }
  modalOpen = false;
  modalEditor.clear();
  $("#editor").hidden = true;
}

// Клік по фону закриває (зі збереженням), але лише якщо і натиснули, і відпустили на фоні.
let editorBackdropDown = false;
$("#editor").addEventListener("mousedown", (e) => (editorBackdropDown = e.target === e.currentTarget));
$("#editor").addEventListener("click", (e) => {
  if (editorBackdropDown && e.target === e.currentTarget) editorClose(true);
});

document.addEventListener("keydown", (e) => {
  if (!modalOpen) return;
  if (e.key === "Escape") editorClose(true);
  else if (e.key === "Enter" && !e.target.closest("button")) editorClose(true);
});

// СКМ: mousedown гасимо, щоб не вмикався автоскрол колесиком.
thumbsBox.addEventListener("mousedown", (e) => {
  if (e.button === 1 && e.target.closest(".thumb")) e.preventDefault();
});
thumbsBox.addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const el = e.target.closest(".thumb");
  if (el) {
    e.preventDefault();
    editorOpen(el.dataset.file);
  }
});

// ---------- панель праворуч: фото під курсором, автозбереження через 0,5 с після зміни
const DOCK_SAVE_DELAY = 500;
const DOCK_HOVER_DELAY = 180;   // щоб курсор, який пролітає над плитками до панелі, не перемикав фото
const dock = new ImageEditor($("#dock"), { pad: 18, onChange: dockSchedule });
let dockTimer = null;
let dockSaving = null;
let hoverTimer = null;

function dockStatus(text, kind = "") {
  const el = $("#dockStatus");
  el.textContent = text;
  el.className = "dock-status push " + kind;
}

function dockSchedule() {
  clearTimeout(dockTimer);
  dockTimer = null;
  if (!dock.dirty()) return dockStatus("");
  dockStatus("Є зміни…", "pending");
  dockTimer = setTimeout(dockFlush, DOCK_SAVE_DELAY);
}

// Зберігає відкладені зміни одразу; завершується, коли файл записано.
async function dockFlush() {
  clearTimeout(dockTimer);
  dockTimer = null;
  if (dockSaving) return dockSaving;
  if (!dock.dirty() || dock.drag) return;
  dockSaving = (async () => {
    const { source, dir, file } = dock;
    dockStatus("Збереження…", "pending");
    const res = await dock.save();
    if (!res.ok) {
      dockStatus("Помилка", "err");
      return toast(res.error, "err");
    }
    dockStatus("Збережено", "ok");
    await afterImageSaved(source, dir, file, res);
  })();
  try {
    await dockSaving;
  } finally {
    dockSaving = null;
  }
}

async function dockShow(file) {
  const source = gallery.source, dir = gallery.active;
  if (dock.drag || (dock.source === source && dock.dir === dir && dock.file === file)) return;
  await dockFlush();
  if (dock.source === source && dock.dir === dir && dock.file === file) return;
  dockStatus("");
  dock.load(source, dir, file);
}

async function dockUndo() {
  if (!dock.file || dock.saving || dockSaving) return;
  if (dock.dirty()) {
    // ще не збережено — просто скидаємо правки
    clearTimeout(dockTimer);
    dockTimer = null;
    Object.assign(dock, { quarter: 0, angle: 0, crop: [0, 0, 1, 1] });
    dock.setAngleInputs(0);
    dock.layout();
    return dockStatus("");
  }
  const { source, dir, file } = dock;
  const res = await eel.editor_undo(source, dir, file)();
  if (!res.ok) return toast(res.error, "err");
  dockStatus("Відмінено", "ok");
  await afterImageSaved(source, dir, file, res);
}

thumbsBox.addEventListener("mouseover", (e) => {
  const el = e.target.closest(".thumb");
  clearTimeout(hoverTimer);
  if (el) hoverTimer = setTimeout(() => el.isConnected && dockShow(el.dataset.file), DOCK_HOVER_DELAY);
});
thumbsBox.addEventListener("mouseleave", () => clearTimeout(hoverTimer));

document.addEventListener("keydown", (e) => {
  if (modalOpen || busy || !$("#modal").hidden) return;
  if (!(e.ctrlKey && (e.key === "z" || e.key === "я" || e.code === "KeyZ"))) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  e.preventDefault();
  dockUndo();
});

// ---------- керування
$("#gallerySrc").addEventListener("change", (e) => {
  e.target.blur(); // щоб стрілки гортали папки, а не селектор
  galleryLoadSource();
});

document.addEventListener("keydown", (e) => {
  if (busy || !$("#modal").hidden || modalOpen || e.altKey || e.ctrlKey) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
  if (!(e.key in moves) || !gallery.dirs.length) return;
  e.preventDefault();
  galleryStep(moves[e.key]);
});

async function galleryApply() {
  if (busy) return;
  if (!gallery.selection.size) return toast("Нічого не вибрано", "err");
  await dockFlush(); // недозбережені правки — до перенесення файлів
  const payload = {};
  gallery.selection.forEach((s, dir) => (payload[dir] = { main: s.main, extra: [...s.extra] }));

  const res = await run("gallery_apply", gallery.source, payload);
  if (!res || !res.ok) return;

  // Перенесені файли знімаємо з вибору, невдалі лишаються виділеними.
  const failed = new Set(res.failed);
  const moved = (dir, f) => payload[dir] && (payload[dir].main === f || payload[dir].extra.includes(f)) &&
    !failed.has(`${dir}/${f}`);
  if (dock.source === gallery.source && moved(dock.dir, dock.file)) dock.clear("Фото перенесено");
  gallery.selection.forEach((s, dir) => {
    if (s.main && !failed.has(`${dir}/${s.main}`)) s.main = null;
    s.extra.forEach((f) => !failed.has(`${dir}/${f}`) && s.extra.delete(f));
    if (!s.main && !s.extra.size) gallery.selection.delete(dir);
  });
  galleryShow(gallery.index); // файли зникли з активної директорії — перечитуємо
}

function packArchives() {
  run("pack_archives");
}

// ------------------------------------------------------------------ старт
(async () => {
  await refreshState();
  const saved = state.config.theme;
  let local = null;
  try { local = localStorage.getItem("theme"); } catch (e) {}
  if (saved && !local) applyTheme(saved);
  requestAnimationFrame(() => document.documentElement.classList.remove("preload"));
})();
