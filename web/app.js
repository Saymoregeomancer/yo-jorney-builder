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

  if (!$("#apiKey").value) $("#apiKey").value = c.api_key || "";
  if (!$("#region").value) $("#region").value = c.region || "";
  if (!$("#proxy").value) $("#proxy").value = c.proxy || "";
  if (!$("#angle").value) setAngle(state.default_angle);

  fillDirSelects();
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
  if (!value) fillDirSelects();
}

async function run(name, ...args) {
  if (busy) return;
  setBusy(true);
  setStatus("working", "Виконується…");
  setProgress(0);
  try {
    const res = await eel[name](...args)();
    handleResult(res);
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

// ------------------------------------------------------------------ старт
(async () => {
  await refreshState();
  const saved = state.config.theme;
  let local = null;
  try { local = localStorage.getItem("theme"); } catch (e) {}
  if (saved && !local) applyTheme(saved);
  requestAnimationFrame(() => document.documentElement.classList.remove("preload"));
})();
