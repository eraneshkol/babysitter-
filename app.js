'use strict';

const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

let currentYearMonth = todayYearMonth();
let liveTimer = null;
let isProcessing = false;

// ---------- utils ----------
function todayYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
function formatDateHe(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}
function formatDuration(minutes) {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}
function formatDurationHMS(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split('-');
  return `${HEBREW_MONTHS[parseInt(m, 10) - 1]} ${y}`;
}
function showToast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), ms);
}
function confirmModal(title, body, okLabel = 'אישור') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmBody').textContent = body;
    const okBtn = document.getElementById('confirmOk');
    okBtn.textContent = okLabel;
    modal.classList.remove('hidden');

    const cleanup = (val) => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(val);
    };
    const cancelBtn = document.getElementById('confirmCancel');
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ---------- view switching ----------
function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  document.getElementById(`view-${name}`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'report') renderReport();
  if (name === 'settings') renderSettings();
}

// ---------- home / toggle ----------
async function renderHome() {
  const state = await DB.getCurrentState();
  const btn = document.getElementById('toggleBtn');
  const label = document.getElementById('toggleLabel');
  const statusLine = document.getElementById('statusLine');

  btn.disabled = false;

  if (state.status === 'in') {
    btn.classList.remove('state-out');
    btn.classList.add('state-in');
    label.textContent = 'יציאה';
    statusLine.textContent = `בכניסה מאז ${formatTime(state.checkInTimestamp)}`;
  } else {
    btn.classList.remove('state-in');
    btn.classList.add('state-out');
    label.textContent = 'כניסה';
    statusLine.textContent = 'לא רשומה כניסה כרגע';
  }

  updateTodaySummary(state);
  startLiveTimer(state);
}

function startLiveTimer(state) {
  clearInterval(liveTimer);
  if (state.status !== 'in') return;
  liveTimer = setInterval(() => updateTodaySummary(state), 1000);
}

function updateTodaySummary(state) {
  const el = document.getElementById('todaySummary');
  if (state.status === 'in' && state.checkInTimestamp) {
    const secs = Math.max(0, Math.round((Date.now() - new Date(state.checkInTimestamp)) / 1000));
    el.textContent = `זמן שעבר: ${formatDurationHMS(secs)}`;
  } else {
    el.textContent = '';
  }
}

async function handleToggleClick() {
  if (isProcessing) return;
  isProcessing = true;
  const btn = document.getElementById('toggleBtn');
  btn.disabled = true;
  try {
    const state = await DB.getCurrentState();
    if (state.status === 'in') {
      await DB.checkOut();
      showToast('נרשמה יציאה');
    } else {
      await DB.checkIn();
      showToast('נרשמה כניסה');
    }
    await renderHome();
  } catch (err) {
    console.error(err);
    showToast('שגיאה בשמירה - נסה שוב');
    btn.disabled = false;
  } finally {
    isProcessing = false;
  }
}

// ---------- report ----------
async function renderReport() {
  document.getElementById('monthLabel').textContent = monthLabel(currentYearMonth);
  const entries = await DB.getEntriesForMonth(currentYearMonth);
  const settings = await DB.getSettings();
  const rate = Number(settings.hourlyRate) || 0;

  const tbody = document.getElementById('entriesBody');
  tbody.innerHTML = '';
  const emptyState = document.getElementById('emptyState');
  emptyState.classList.toggle('hidden', entries.length > 0);

  let totalMinutes = 0;
  for (const entry of entries) {
    const tr = document.createElement('tr');
    let mins = entry.durationMinutes;
    if (mins == null) {
      mins = Math.max(0, Math.round((Date.now() - new Date(entry.checkIn)) / 60000));
      tr.classList.add('in-progress');
    }
    totalMinutes += mins;
    tr.innerHTML = `
      <td>${formatDateHe(entry.date)}</td>
      <td>${formatTime(entry.checkIn)}</td>
      <td>${entry.checkOut ? formatTime(entry.checkOut) : 'פעיל'}</td>
      <td>${formatDuration(mins)}</td>
    `;
    tbody.appendChild(tr);
  }

  document.getElementById('totalHours').textContent = formatDuration(totalMinutes);
  const totalPay = (totalMinutes / 60) * rate;
  document.getElementById('totalPay').textContent = `₪${totalPay.toLocaleString('he-IL', { maximumFractionDigits: 0 })}`;
}

function changeMonth(delta) {
  const [y, m] = currentYearMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentYearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderReport();
}

// ---------- settings ----------
async function renderSettings() {
  const settings = await DB.getSettings();
  document.getElementById('rateInput').value = settings.hourlyRate || '';
  const mirrorRaw = localStorage.getItem('babysitter_mirror_v1');
  const info = document.getElementById('lastBackupInfo');
  if (mirrorRaw) {
    try {
      const parsed = JSON.parse(mirrorRaw);
      const d = new Date(parsed.savedAt);
      info.textContent = `עותק גיבוי מקומי עדכני מ-${d.toLocaleString('he-IL')}`;
    } catch {
      info.textContent = '';
    }
  }
}

async function handleSaveRate() {
  const val = Number(document.getElementById('rateInput').value);
  if (isNaN(val) || val < 0) {
    showToast('תעריף לא תקין');
    return;
  }
  await DB.saveSettings(val);
  showToast('התעריף נשמר');
  renderReport();
}

async function handleExport() {
  const data = await DB.exportBackupObject();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `babysitter-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('הגיבוי הורד בהצלחה');
}

async function handleImportFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const ok = await confirmModal(
      'ייבוא גיבוי',
      `הפעולה תחליף את כל הנתונים הקיימים באפליקציה בנתונים מהקובץ (${(data.entries || []).length} רישומים). להמשיך?`,
      'ייבוא'
    );
    if (!ok) return;
    await DB.importBackupObject(data);
    showToast('הייבוא הושלם בהצלחה');
    await renderHome();
    await renderReport();
    await renderSettings();
  } catch (err) {
    console.error(err);
    showToast('שגיאה: קובץ הגיבוי לא תקין');
  }
}

async function handleReset() {
  const ok1 = await confirmModal(
    'איפוס כל הנתונים',
    'פעולה זו תמחק לצמיתות את כל הרישומים וההיסטוריה. מומלץ לייצא גיבוי לפני שממשיכים. האם אתה בטוח?'
  );
  if (!ok1) return;
  const ok2 = await confirmModal(
    'אישור אחרון',
    'זו הפעולה האחרונה לפני מחיקה סופית - לא ניתן לשחזר לאחר מכן. להמשיך במחיקה?',
    'מחק הכל'
  );
  if (!ok2) return;
  await DB.resetAllData();
  showToast('כל הנתונים אופסו');
  currentYearMonth = todayYearMonth();
  await renderHome();
  await renderReport();
  await renderSettings();
}

// ---------- init ----------
async function init() {
  await DB.initAndSelfHeal();

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.getElementById('toggleBtn').addEventListener('click', handleToggleClick);
  document.getElementById('prevMonthBtn').addEventListener('click', () => changeMonth(-1));
  document.getElementById('nextMonthBtn').addEventListener('click', () => changeMonth(1));
  document.getElementById('saveRateBtn').addEventListener('click', handleSaveRate);
  document.getElementById('exportBtn').addEventListener('click', handleExport);
  document.getElementById('importInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  });
  document.getElementById('resetBtn').addEventListener('click', handleReset);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      renderHome();
    }
  });

  await renderHome();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.error('SW registration failed', err));
  }
}

document.addEventListener('DOMContentLoaded', init);
