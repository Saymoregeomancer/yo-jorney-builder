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
const PREVIEW_BOX = 240;   // прев'ю при наведенні, CSS px
const THUMB_BATCH = 24;
const THUMB_CACHE_MAX = 3000;

const gallery = {
  source: "",               // папка-джерело (відносно Основної директорії)
  dirs: [],                 // директорії-артикули в джерелі
  index: 0,
  active: "",               // назва активної директорії — потрібна при перенесенні
  files: [],
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
  hidePreview();
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
    el.innerHTML = `<img alt="" decoding="async" /><span class="badge"></span>`;
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
  const img = el.firstElementChild;
  img.onload = () => el.classList.add("ready");
  img.src = url;
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

// ---------- прев'ю при наведенні
const previewPop = $("#previewPop");
let previewFor = null;
let previewTimer = null;

thumbsBox.addEventListener("mouseover", (e) => {
  const el = e.target.closest(".thumb");
  if (!el || el === previewFor) return;
  previewFor = el;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => showPreview(el), 140);
});
// Ховаємо, щойно курсор залишив плитку (зокрема в проміжок між плитками).
thumbsBox.addEventListener("mouseout", (e) => {
  const el = e.target.closest(".thumb");
  if (el && !el.contains(e.relatedTarget)) hidePreview();
});
thumbsBox.addEventListener("mouseleave", hidePreview);
thumbsBox.addEventListener("scroll", hidePreview, { passive: true });
window.addEventListener("blur", hidePreview);

async function showPreview(el) {
  const file = el.dataset.file;
  const dir = gallery.active;
  const px = pxBox(PREVIEW_BOX);
  const key = cacheKey(dir, file, px);
  let url = thumbCache.get(key);
  if (!url) {
    const res = await eel.gallery_thumbs(gallery.source, dir, [file], px)();
    url = res[file];
    if (url) cachePut(key, url);
  }
  if (previewFor !== el || !el.isConnected || !url) return;

  $("#previewImg").src = url;
  $("#previewName").textContent = file;
  const r = el.getBoundingClientRect();
  const w = previewPop.offsetWidth, h = previewPop.offsetHeight;
  let left = r.left - w - 12;                       // галерея справа — прев'ю ліворуч
  if (left < 10) left = Math.min(r.right + 12, window.innerWidth - w - 10);
  const top = Math.max(10, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 10));
  previewPop.style.transform = `translate(${left}px, ${top}px)`;
  previewPop.classList.add("show");
}

function hidePreview() {
  clearTimeout(previewTimer);
  previewFor = null;
  previewPop.classList.remove("show");
}

// ---------- редактор фото: СКМ по плитці — обрізка / нахил, збереження поверх оригіналу
const editor = {
  open: false,
  saving: false,
  dir: "",
  file: "",
  img: null,                // прев'ю (зменшене)
  W: 0, H: 0,               // розмір оригіналу
  alpha: false,
  quarter: 0,               // повороти на 90° за годинниковою
  angle: 0,                 // нахил, градуси за годинниковою
  crop: [0, 0, 1, 1],       // x, y, w, h — частки від повернутого кадру
  view: { left: 0, top: 0, w: 0, h: 0 }, // де намальований кадр у сцені, CSS px
};
const editorStage = $("#editorStage");
const editorCanvas = $("#editorCanvas");
const editorCropEl = $("#editorCrop");
const EDITOR_PAD = 28;      // відступ кадру від країв сцени — щоб було за що хапати рамку

// Повернутий кадр (у пікселях прев'ю) з розширенням під кути, як у PIL rotate(expand=True).
function editorFrame() {
  const { naturalWidth: iw, naturalHeight: ih } = editor.img;
  const [bw, bh] = editor.quarter % 2 ? [ih, iw] : [iw, ih];
  const a = (editor.angle * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return { iw, ih, bw, bh, FW: bw * c + bh * s, FH: bw * s + bh * c };
}

// Найбільший прямокутник з пропорціями фото, що вміщується в нахилене фото — без порожніх кутів.
function editorAutoCrop() {
  const { bw, bh, FW, FH } = editorFrame();
  const k = Math.min(bw / FW, bh / FH);
  const w = Math.min(1, (k * bw) / FW), h = Math.min(1, (k * bh) / FH);
  editor.crop = [(1 - w) / 2, (1 - h) / 2, w, h];
}

function editorDirty() {
  const [x, y, w, h] = editor.crop;
  const eps = 0.001;
  return editor.quarter % 4 !== 0 || Math.abs(editor.angle) > 0.01 ||
    x > eps || y > eps || w < 1 - eps || h < 1 - eps;
}

function editorLayout() {
  if (!editor.img) return;
  const { iw, ih, FW, FH } = editorFrame();
  const sw = editorStage.clientWidth, sh = editorStage.clientHeight;
  const k = Math.max(0.01, Math.min((sw - EDITOR_PAD * 2) / FW, (sh - EDITOR_PAD * 2) / FH));
  const w = FW * k, h = FH * k;
  editor.view = { left: (sw - w) / 2, top: (sh - h) / 2, w, h };

  const dpr = window.devicePixelRatio || 1;
  editorCanvas.width = Math.round(w * dpr);
  editorCanvas.height = Math.round(h * dpr);
  Object.assign(editorCanvas.style, {
    left: editor.view.left + "px", top: editor.view.top + "px", width: w + "px", height: h + "px",
  });
  const ctx = editorCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
  if (!editor.alpha) {
    ctx.fillStyle = "#fff";         // так само заповнюються кути при збереженні
    ctx.fillRect(0, 0, FW, FH);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.translate(FW / 2, FH / 2);
  ctx.rotate(((editor.quarter * 90 + editor.angle) * Math.PI) / 180);
  ctx.drawImage(editor.img, -iw / 2, -ih / 2, iw, ih);
  editorPaintCrop();
}

function editorPaintCrop() {
  const [x, y, w, h] = editor.crop;
  const v = editor.view;
  Object.assign(editorCropEl.style, {
    left: v.left + x * v.w + "px", top: v.top + y * v.h + "px",
    width: w * v.w + "px", height: h * v.h + "px",
  });
  const { FW, FH, iw } = editorFrame();
  const r = editor.W / iw;  // прев'ю → оригінал
  const outW = Math.round(w * FW * r), outH = Math.round(h * FH * r);
  $("#editorSize").textContent = editorDirty()
    ? `${editor.W}×${editor.H} → ${outW}×${outH}`
    : `${editor.W}×${editor.H}`;
}

async function editorOpen(file) {
  if (busy || editor.open) return;
  hidePreview();
  Object.assign(editor, {
    open: true, dir: gallery.active, file, img: null,
    quarter: 0, angle: 0, crop: [0, 0, 1, 1],
  });
  editorSetAngleInputs(0);
  $("#editorName").textContent = file;
  $("#editorSize").textContent = "";
  $("#editorLoading").textContent = "Завантаження…";
  $("#editorLoading").hidden = false;
  editorCropEl.hidden = true;
  editorCanvas.width = editorCanvas.height = 0;
  $("#editor").hidden = false;

  const box = Math.round(Math.max(editorStage.clientWidth, editorStage.clientHeight) * (window.devicePixelRatio || 1));
  const res = await eel.editor_open(gallery.source, editor.dir, file, box)();
  if (!editor.open || editor.file !== file) return;
  if (!res.ok) {
    toast(res.error, "err");
    return editorClose(false);
  }
  const img = new Image();
  img.onload = () => {
    if (!editor.open || editor.file !== file) return;
    Object.assign(editor, { img, W: res.width, H: res.height, alpha: res.alpha });
    $("#editorLoading").hidden = true;
    editorCropEl.hidden = false;
    editorLayout();
  };
  img.src = res.url;
}

async function editorClose(save) {
  if (!editor.open || editor.saving) return;
  if (save && editor.img && editorDirty()) {
    editor.saving = true;
    $("#editorLoading").textContent = "Збереження…";
    $("#editorLoading").hidden = false;
    const res = await eel.editor_save(gallery.source, editor.dir, editor.file,
      editor.quarter, editor.angle, editor.crop)();
    editor.saving = false;
    $("#editorLoading").hidden = true;
    if (!res.ok) return toast(res.error, "err"); // правки не губимо — редактор лишається відкритим
    toast(res.message);
    editorRefreshThumb(editor.dir, editor.file);
  }
  editor.open = false;
  editor.img = null;
  $("#editor").hidden = true;
}

function editorRefreshThumb(dir, file) {
  const prefix = `${gallery.source}/${dir}/${file}@`;
  for (const key of [...thumbCache.keys()]) if (key.startsWith(prefix)) thumbCache.delete(key);
  const el = dir === gallery.active && gallery.els.get(file);
  if (!el) return;
  el.classList.remove("ready", "broken");
  thumbObserver.observe(el); // видима плитка одразу потрапить у чергу і перемалюється
}

function editorQuarter(delta) {
  if (!editor.img) return;
  editor.quarter = (editor.quarter + delta + 4) % 4;
  editorAutoCrop();
  editorLayout();
}

function editorSetAngleInputs(v) {
  $("#editorAngle").value = v;
  $("#editorAngleNum").value = v;
}

function editorSetAngle(v) {
  v = Math.max(-45, Math.min(45, Number(v) || 0));
  editor.angle = Math.round(v * 10) / 10;
  if (!editor.img) return;
  editorAutoCrop();
  editorLayout();
}

function editorReset() {
  if (!editor.img) return;
  Object.assign(editor, { quarter: 0, angle: 0, crop: [0, 0, 1, 1] });
  editorSetAngleInputs(0);
  editorLayout();
}

$("#editorAngle").addEventListener("input", (e) => {
  $("#editorAngleNum").value = e.target.value;
  editorSetAngle(e.target.value);
});
$("#editorAngle").addEventListener("dblclick", () => {
  editorSetAngleInputs(0);
  editorSetAngle(0);
});
$("#editorAngleNum").addEventListener("input", (e) => {
  $("#editorAngle").value = e.target.value;
  editorSetAngle(e.target.value);
});

// Перетягування: ручки — краї/кути, всередині рамки — зсув, поза рамкою — нова рамка.
let cropDrag = null;

editorStage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !editor.img || editor.saving) return;
  const v = editor.view;
  const mode = e.target.dataset.h || (e.target === editorCropEl ? "move" : "new");
  const px = (e.clientX - editorStage.getBoundingClientRect().left - v.left) / v.w;
  const py = (e.clientY - editorStage.getBoundingClientRect().top - v.top) / v.h;
  cropDrag = { mode, sx: e.clientX, sy: e.clientY, start: [...editor.crop],
    ax: Math.max(0, Math.min(1, px)), ay: Math.max(0, Math.min(1, py)) };
  editorStage.setPointerCapture(e.pointerId);
  e.preventDefault();
});

editorStage.addEventListener("pointermove", (e) => {
  if (!cropDrag) return;
  const v = editor.view;
  const dx = (e.clientX - cropDrag.sx) / v.w, dy = (e.clientY - cropDrag.sy) / v.h;
  const minW = 16 / v.w, minH = 16 / v.h;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  let [x, y, w, h] = cropDrag.start;
  let r = x + w, b = y + h;
  const m = cropDrag.mode;

  if (m === "move") {
    x = clamp(x + dx, 0, 1 - w);
    y = clamp(y + dy, 0, 1 - h);
    editor.crop = [x, y, w, h];
  } else if (m === "new") {
    const cx = clamp(cropDrag.ax + dx, 0, 1), cy = clamp(cropDrag.ay + dy, 0, 1);
    editor.crop = [Math.min(cropDrag.ax, cx), Math.min(cropDrag.ay, cy),
      Math.abs(cx - cropDrag.ax), Math.abs(cy - cropDrag.ay)];
  } else {
    if (m.includes("w")) x = clamp(x + dx, 0, r - minW);
    if (m.includes("e")) r = clamp(r + dx, x + minW, 1);
    if (m.includes("n")) y = clamp(y + dy, 0, b - minH);
    if (m.includes("s")) b = clamp(b + dy, y + minH, 1);
    editor.crop = [x, y, r - x, b - y];
  }
  editorPaintCrop();
});

function endCropDrag() {
  if (!cropDrag) return;
  const [, , w, h] = editor.crop;
  const v = editor.view;
  if (cropDrag.mode === "new" && (w * v.w < 16 || h * v.h < 16)) {
    editor.crop = cropDrag.start; // випадковий клік — рамку не чіпаємо
    editorPaintCrop();
  }
  cropDrag = null;
}
editorStage.addEventListener("pointerup", endCropDrag);
editorStage.addEventListener("pointercancel", endCropDrag);

// Клік по фону закриває (зі збереженням), але лише якщо і натиснули, і відпустили на фоні.
let editorBackdropDown = false;
$("#editor").addEventListener("mousedown", (e) => (editorBackdropDown = e.target === e.currentTarget));
$("#editor").addEventListener("click", (e) => {
  if (editorBackdropDown && e.target === e.currentTarget) editorClose(true);
});

document.addEventListener("keydown", (e) => {
  if (!editor.open) return;
  if (e.key === "Escape") editorClose(true);
  else if (e.key === "Enter" && !e.target.closest("button")) editorClose(true);
});

window.addEventListener("resize", () => editor.open && editorLayout());

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

// ---------- керування
$("#gallerySrc").addEventListener("change", (e) => {
  e.target.blur(); // щоб стрілки гортали папки, а не селектор
  galleryLoadSource();
});

document.addEventListener("keydown", (e) => {
  if (busy || !$("#modal").hidden || editor.open || e.altKey || e.ctrlKey) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
  if (!(e.key in moves) || !gallery.dirs.length) return;
  e.preventDefault();
  galleryStep(moves[e.key]);
});

async function galleryApply() {
  if (busy) return;
  if (!gallery.selection.size) return toast("Нічого не вибрано", "err");
  const payload = {};
  gallery.selection.forEach((s, dir) => (payload[dir] = { main: s.main, extra: [...s.extra] }));

  const res = await run("gallery_apply", gallery.source, payload);
  if (!res || !res.ok) return;

  // Перенесені файли знімаємо з вибору, невдалі лишаються виділеними.
  const failed = new Set(res.failed);
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
