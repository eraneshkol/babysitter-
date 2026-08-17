'use strict';

// חייב להירשם באופן סינכרוני, מיד עם טעינת הסקריפט - הדפדפן עלול לירות את
// beforeinstallprompt לפני ש-DOMContentLoaded מסתיים, ואם הליסנר נרשם מאוחר יותר
// (בתוך init) האירוע פשוט אובד ולעולם לא נדע שהאפליקציה ניתנת להתקנה בטעינה הזו.
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (typeof updateInstallButtonVisibility === 'function') updateInstallButtonVisibility();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (typeof updateInstallButtonVisibility === 'function') updateInstallButtonVisibility();
});

const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

let currentYearMonth = todayYearMonth();
let liveTimer = null;
let isProcessing = false;
let activeCaregiverId = null; // מי הכפתור הגדול במסך הבית שולט בה כרגע
let reportCaregiverId = null; // מי מוצגת כרגע בדוח החודשי
let editingCaregiverId = null;
let editingEntryId = null; // הרשומה שנערכת כרגע במודל הידני, null = מצב "הוספה חדשה"

const ICONS = {
  user: '<svg class="icon" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  edit: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg class="icon" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

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
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
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
  const allCaregivers = await DB.getAllCaregivers();
  const activeCaregivers = allCaregivers.filter((c) => !c.archived);

  const btn = document.getElementById('toggleBtn');
  const label = document.getElementById('toggleLabel');
  const statusLine = document.getElementById('statusLine');

  if (activeCaregivers.length === 0) {
    document.getElementById('caregiverSelector').classList.add('hidden');
    document.getElementById('caregiverSelector').innerHTML = '';
    statusLine.textContent = 'הוסיפי מטפלת במסך ההגדרות כדי להתחיל';
    document.getElementById('todaySummary').textContent = '';
    btn.disabled = true;
    btn.classList.remove('state-in');
    btn.classList.add('state-out');
    label.textContent = 'כניסה';
    clearInterval(liveTimer);
    return;
  }

  let storedActiveId = await DB.getActiveCaregiverId();
  if (!storedActiveId || !activeCaregivers.some((c) => c.id === storedActiveId)) {
    storedActiveId = activeCaregivers[0].id;
    await DB.setActiveCaregiverId(storedActiveId);
  }
  activeCaregiverId = storedActiveId;

  const states = {};
  for (const c of activeCaregivers) {
    states[c.id] = await DB.getCurrentState(c.id);
  }
  renderCaregiverSelector(activeCaregivers, activeCaregiverId, states);

  const state = states[activeCaregiverId];
  const activeCaregiver = activeCaregivers.find((c) => c.id === activeCaregiverId);
  const namePrefix = activeCaregivers.length > 1 ? `${activeCaregiver.name} - ` : '';

  btn.disabled = false;
  if (state.status === 'in') {
    btn.classList.remove('state-out');
    btn.classList.add('state-in');
    label.textContent = 'יציאה';
    statusLine.textContent = `${namePrefix}בכניסה מאז ${formatTime(state.checkInTimestamp)}`;
  } else {
    btn.classList.remove('state-in');
    btn.classList.add('state-out');
    label.textContent = 'כניסה';
    statusLine.textContent = `${namePrefix}לא רשומה כניסה כרגע`;
  }

  updateTodaySummary(state);
  startLiveTimer(state);
}

function renderCaregiverSelector(caregivers, activeId, states) {
  const container = document.getElementById('caregiverSelector');
  if (caregivers.length <= 1) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = '';
  for (const c of caregivers) {
    const chip = document.createElement('button');
    chip.type = 'button';
    const isIn = states[c.id] && states[c.id].status === 'in';
    chip.className = 'caregiver-chip' + (isIn ? ' chip-in' : '') + (c.id === activeId ? ' selected' : '');
    chip.textContent = c.name;
    chip.addEventListener('click', () => selectCaregiver(c.id));
    container.appendChild(chip);
  }
}

async function selectCaregiver(id) {
  if (id === activeCaregiverId) return;
  activeCaregiverId = id;
  await DB.setActiveCaregiverId(id);
  await renderHome();
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
  if (isProcessing || !activeCaregiverId) return;
  isProcessing = true;
  const btn = document.getElementById('toggleBtn');
  btn.disabled = true;
  try {
    const state = await DB.getCurrentState(activeCaregiverId);
    if (state.status === 'in') {
      await DB.checkOut(activeCaregiverId);
      showToast('נרשמה יציאה');
    } else {
      await DB.checkIn(activeCaregiverId);
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
  const allCaregivers = await DB.getAllCaregivers();
  const select = document.getElementById('reportCaregiverSelect');

  if (allCaregivers.length === 0) {
    select.classList.add('hidden');
    select.innerHTML = '';
    document.getElementById('monthLabel').textContent = monthLabel(currentYearMonth);
    document.getElementById('totalHours').textContent = '0:00';
    document.getElementById('totalPay').textContent = '₪0';
    document.getElementById('entriesBody').innerHTML = '';
    document.getElementById('emptyState').classList.remove('hidden');
    return;
  }

  if (!reportCaregiverId || !allCaregivers.some((c) => c.id === reportCaregiverId)) {
    reportCaregiverId =
      activeCaregiverId && allCaregivers.some((c) => c.id === activeCaregiverId) ? activeCaregiverId : allCaregivers[0].id;
  }

  if (allCaregivers.length > 1) {
    select.classList.remove('hidden');
    select.innerHTML = allCaregivers
      .map(
        (c) =>
          `<option value="${c.id}" ${c.id === reportCaregiverId ? 'selected' : ''}>${escapeHtml(c.name)}${c.archived ? ' (בארכיון)' : ''}</option>`
      )
      .join('');
  } else {
    select.classList.add('hidden');
    select.innerHTML = '';
  }

  const caregiver = allCaregivers.find((c) => c.id === reportCaregiverId);
  const rate = caregiver ? Number(caregiver.hourlyRate) || 0 : 0;

  document.getElementById('monthLabel').textContent = monthLabel(currentYearMonth);
  const entries = await DB.getEntriesForCaregiverMonth(reportCaregiverId, currentYearMonth);

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
    tr.addEventListener('click', () => openEntryModal(entry));
    tbody.appendChild(tr);
  }

  document.getElementById('totalHours').textContent = formatDuration(totalMinutes);

  const deduction = await DB.getDeduction(reportCaregiverId, currentYearMonth);
  const deductionInput = document.getElementById('deductionInput');
  if (document.activeElement !== deductionInput) {
    deductionInput.value = deduction || '';
  }

  const rawPay = (totalMinutes / 60) * rate;
  const totalPay = rawPay - deduction;
  document.getElementById('totalPay').textContent = `₪${totalPay.toLocaleString('he-IL', { maximumFractionDigits: 0 })}`;
}

async function handleDeductionChange() {
  const input = document.getElementById('deductionInput');
  const val = Number(input.value);
  if (input.value !== '' && (isNaN(val) || val < 0)) {
    showToast('סכום קיזוז לא תקין');
    return;
  }
  await DB.setDeduction(reportCaregiverId, currentYearMonth, val || 0);
  await renderReport();
}

// ---------- report: manual entry add/edit/delete ----------
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timeStrFromIso(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function openEntryModal(entry) {
  editingEntryId = entry ? entry.id : null;
  document.getElementById('entryModalTitle').textContent = entry ? 'עריכת רשומה' : 'הוספת רשומה ידנית';
  const dateInput = document.getElementById('entryDateInput');
  const inInput = document.getElementById('entryCheckInInput');
  const outInput = document.getElementById('entryCheckOutInput');

  if (entry) {
    dateInput.value = entry.date;
    inInput.value = timeStrFromIso(entry.checkIn);
    outInput.value = entry.checkOut ? timeStrFromIso(entry.checkOut) : '';
  } else {
    dateInput.value = currentYearMonth === todayYearMonth() ? todayDateStr() : `${currentYearMonth}-01`;
    inInput.value = '';
    outInput.value = '';
  }

  document.getElementById('entryDeleteBtn').classList.toggle('hidden', !entry);
  document.getElementById('entryModal').classList.remove('hidden');
}

function closeEntryModal() {
  document.getElementById('entryModal').classList.add('hidden');
  editingEntryId = null;
}

async function handleSaveEntry() {
  const dateStr = document.getElementById('entryDateInput').value;
  const inTime = document.getElementById('entryCheckInInput').value;
  const outTime = document.getElementById('entryCheckOutInput').value;

  if (!dateStr || !inTime || !outTime) {
    showToast('יש למלא תאריך, שעת כניסה ושעת יציאה');
    return;
  }

  if (inTime === outTime) {
    showToast('שעת הכניסה והיציאה זהות - זו כנראה טעות');
    return;
  }

  const checkInDate = new Date(`${dateStr}T${inTime}:00`);
  let checkOutDate = new Date(`${dateStr}T${outTime}:00`);
  if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
    showToast('תאריך או שעה לא תקינים');
    return;
  }
  if (checkOutDate <= checkInDate) {
    checkOutDate = new Date(checkOutDate.getTime() + 24 * 60 * 60 * 1000); // משמרת שחוצה חצות
  }

  try {
    if (editingEntryId) {
      await DB.updateEntry(editingEntryId, checkInDate.toISOString(), checkOutDate.toISOString());
      showToast('הרשומה עודכנה');
    } else {
      if (!reportCaregiverId) {
        showToast('יש לבחור מטפלת קודם');
        return;
      }
      await DB.addManualEntry(reportCaregiverId, checkInDate.toISOString(), checkOutDate.toISOString());
      showToast('הרשומה נוספה');
    }
  } catch (err) {
    console.error(err);
    showToast('שגיאה בשמירה');
    return;
  }

  closeEntryModal();
  const newYearMonth = `${checkInDate.getFullYear()}-${String(checkInDate.getMonth() + 1).padStart(2, '0')}`;
  if (newYearMonth !== currentYearMonth) currentYearMonth = newYearMonth;
  await renderReport();
  await renderHome();
}

async function handleDeleteEntry() {
  if (!editingEntryId) return;
  const ok = await confirmModal('מחיקת רשומה', 'האם למחוק את הרשומה הזו? לא ניתן לשחזר.', 'מחיקה');
  if (!ok) return;
  await DB.deleteEntry(editingEntryId);
  closeEntryModal();
  showToast('הרשומה נמחקה');
  await renderReport();
  await renderHome();
}

function changeMonth(delta) {
  const [y, m] = currentYearMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  currentYearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderReport();
}

// ---------- report: export to Excel-compatible CSV + share ----------
function csvEscape(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCaregiverMonthCsv(caregiver, yearMonth, entries, deduction) {
  const rows = [['תאריך', 'כניסה', 'יציאה', 'שעות']];
  let totalMinutes = 0;
  for (const entry of entries) {
    let mins = entry.durationMinutes;
    if (mins == null) mins = Math.max(0, Math.round((Date.now() - new Date(entry.checkIn)) / 60000));
    totalMinutes += mins;
    rows.push([formatDateHe(entry.date), formatTime(entry.checkIn), entry.checkOut ? formatTime(entry.checkOut) : 'פעיל', formatDuration(mins)]);
  }
  rows.push([]);
  rows.push(['סה"כ שעות', '', '', formatDuration(totalMinutes)]);
  const rawPay = (totalMinutes / 60) * (Number(caregiver.hourlyRate) || 0);
  if (deduction) {
    rows.push(['קיזוזים', '', '', `₪${Number(deduction).toLocaleString('he-IL', { maximumFractionDigits: 0 })}`]);
  }
  const totalPay = rawPay - (Number(deduction) || 0);
  rows.push(['לתשלום', '', '', `₪${totalPay.toLocaleString('he-IL', { maximumFractionDigits: 0 })}`]);
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  return String.fromCharCode(0xfeff) + csv; // BOM so Excel reads the Hebrew as UTF-8 correctly
}

async function handleShareReport() {
  const allCaregivers = await DB.getAllCaregivers();
  const caregiver = allCaregivers.find((c) => c.id === reportCaregiverId);
  if (!caregiver) {
    showToast('אין מטפלת נבחרת');
    return;
  }
  const entries = await DB.getEntriesForCaregiverMonth(reportCaregiverId, currentYearMonth);
  const deduction = await DB.getDeduction(reportCaregiverId, currentYearMonth);
  const csv = buildCaregiverMonthCsv(caregiver, currentYearMonth, entries, deduction);
  const filename = `${caregiver.name}-${monthLabel(currentYearMonth)}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });

  if (navigator.canShare && navigator.share) {
    const file = new File([blob], filename, { type: 'text/csv' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `דוח שעות - ${caregiver.name}`, text: `דוח שעות ${monthLabel(currentYearMonth)} - ${caregiver.name}` });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // המשתמשת ביטלה את השיתוף
        console.error(err);
      }
    }
  }

  // נפילה חזרה: פשוט מורידים את הקובץ אם שיתוף קבצים לא נתמך בדפדפן הזה
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('הקובץ הורד - אפשר לשתף אותו מאפליקציית הקבצים');
}

// ---------- settings: caregivers ----------
async function renderSettings() {
  updateInstallButtonVisibility();
  const caregivers = await DB.getAllCaregivers();
  renderCaregiverList(caregivers);

  const mirrorRaw = localStorage.getItem('babysitter_mirror_v2');
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

function renderCaregiverList(caregivers) {
  const container = document.getElementById('caregiverList');
  container.innerHTML = '';
  if (caregivers.length === 0) {
    container.innerHTML = '<p class="last-backup-info">אין עדיין מטפלות. הוסיפי אחת למטה.</p>';
    return;
  }
  for (const c of caregivers) {
    const row = document.createElement('div');
    row.className = 'caregiver-row';
    if (editingCaregiverId === c.id) {
      row.innerHTML = `
        <div class="caregiver-avatar">${ICONS.user}</div>
        <div class="caregiver-info">
          <input type="text" class="edit-name-input" value="${escapeHtml(c.name)}" />
          <input type="number" class="edit-rate-input" value="${c.hourlyRate || 0}" min="0" step="1" />
        </div>
        <div class="caregiver-actions">
          <button class="icon-btn" data-action="save" data-id="${c.id}" aria-label="שמירה">${ICONS.check}</button>
          <button class="icon-btn" data-action="cancel" aria-label="ביטול">${ICONS.x}</button>
        </div>
      `;
    } else {
      row.innerHTML = `
        <div class="caregiver-avatar">${ICONS.user}</div>
        <div class="caregiver-info">
          <div class="caregiver-name">${escapeHtml(c.name)}</div>
          <div class="caregiver-meta">
            ${c.archived ? '<span class="status-pill">בארכיון</span>' : ''}
            <span class="caregiver-rate">₪${c.hourlyRate || 0} לשעה</span>
          </div>
        </div>
        <div class="caregiver-actions">
          ${c.archived ? '' : `<button class="icon-btn" data-action="edit" data-id="${c.id}" aria-label="עריכה">${ICONS.edit}</button>`}
          ${c.archived ? '' : `<button class="icon-btn danger" data-action="remove" data-id="${c.id}" aria-label="הסרה">${ICONS.trash}</button>`}
        </div>
      `;
    }
    container.appendChild(row);
  }
  container.querySelectorAll('[data-action="edit"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      editingCaregiverId = btn.dataset.id;
      renderSettings();
    })
  );
  container.querySelectorAll('[data-action="cancel"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      editingCaregiverId = null;
      renderSettings();
    })
  );
  container.querySelectorAll('[data-action="remove"]').forEach((btn) =>
    btn.addEventListener('click', () => handleRemoveCaregiver(btn.dataset.id))
  );
  container.querySelectorAll('[data-action="save"]').forEach((btn) =>
    btn.addEventListener('click', () => handleSaveCaregiverEdit(btn.dataset.id))
  );
}

async function handleAddCaregiver() {
  const nameInput = document.getElementById('newCaregiverName');
  const rateInput = document.getElementById('newCaregiverRate');
  const name = nameInput.value.trim();
  const rate = Number(rateInput.value);
  if (!name) {
    showToast('נא להזין שם');
    return;
  }
  if (rateInput.value === '' || isNaN(rate) || rate < 0) {
    showToast('תעריף לא תקין');
    return;
  }
  await DB.addCaregiver(name, rate);
  nameInput.value = '';
  rateInput.value = '';
  showToast('המטפלת נוספה');
  await renderSettings();
  await renderHome();
}

async function handleSaveCaregiverEdit(id) {
  const row = document.querySelector(`[data-action="save"][data-id="${id}"]`).closest('.caregiver-row');
  const name = row.querySelector('.edit-name-input').value.trim();
  const rate = Number(row.querySelector('.edit-rate-input').value);
  if (!name) {
    showToast('נא להזין שם');
    return;
  }
  if (isNaN(rate) || rate < 0) {
    showToast('תעריף לא תקין');
    return;
  }
  await DB.updateCaregiver(id, { name, hourlyRate: rate });
  editingCaregiverId = null;
  showToast('העדכון נשמר');
  await renderSettings();
  await renderHome();
  await renderReport();
}

async function handleRemoveCaregiver(id) {
  const caregivers = await DB.getAllCaregivers();
  const c = caregivers.find((x) => x.id === id);
  if (!c) return;
  const ok = await confirmModal(
    'הסרת מטפלת',
    `להסיר את ${c.name}? אם יש לה רישומי שעות, הם יישמרו וההיסטוריה תישאר זמינה בדוח, אבל היא לא תופיע יותר ברשימת הכניסה/יציאה.`,
    'הסרה'
  );
  if (!ok) return;
  const result = await DB.removeCaregiver(id);
  showToast(result.archived ? 'המטפלת הועברה לארכיון (ההיסטוריה נשמרה)' : 'המטפלת הוסרה');
  await renderSettings();
  await renderHome();
}

// ---------- settings: backup ----------
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
    const entryCount = (data.entries || []).length;
    const caregiverCount = Array.isArray(data.caregivers) ? data.caregivers.length : 1;
    const ok = await confirmModal(
      'ייבוא גיבוי',
      `הפעולה תחליף את כל הנתונים הקיימים באפליקציה בנתונים מהקובץ (${entryCount} רישומים, ${caregiverCount} מטפלות). להמשיך?`,
      'ייבוא'
    );
    if (!ok) return;
    await DB.importBackupObject(data);
    activeCaregiverId = null;
    reportCaregiverId = null;
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
    'פעולה זו תמחק לצמיתות את כל הרישומים, ההיסטוריה וכל המטפלות. מומלץ לייצא גיבוי לפני שממשיכים. האם אתה בטוח?'
  );
  if (!ok1) return;
  const ok2 = await confirmModal(
    'אישור אחרון',
    'זו הפעולה האחרונה לפני מחיקה סופית - לא ניתן לשחזר לאחר מכן. להמשיך במחיקה?',
    'מחק הכל'
  );
  if (!ok2) return;
  await DB.resetAllData();
  await DB.initAndSelfHeal(); // יוצר מחדש מטפלת ברירת מחדל כדי שהאפליקציה לא תישאר ריקה
  activeCaregiverId = null;
  reportCaregiverId = null;
  editingCaregiverId = null;
  showToast('כל הנתונים אופסו');
  currentYearMonth = todayYearMonth();
  await renderHome();
  await renderReport();
  await renderSettings();
}

// ---------- settings: install app ----------
function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isChromeOnIOS() {
  return /CriOS/i.test(navigator.userAgent);
}

function updateInstallButtonVisibility() {
  const btn = document.getElementById('installAppBtn');
  const info = document.getElementById('installInfo');
  if (!btn || !info) return;

  if (isStandaloneDisplay()) {
    btn.classList.add('hidden');
    info.textContent = 'האפליקציה כבר מותקנת על המכשיר ✓';
    info.classList.remove('hidden');
  } else if (deferredInstallPrompt) {
    btn.textContent = 'התקנת האפליקציה על הטלפון';
    btn.classList.remove('hidden');
    info.classList.add('hidden');
  } else if (isIOS()) {
    btn.textContent = isChromeOnIOS() ? 'להתקנה: יש לפתוח בספארי' : 'איך מתקינים על אייפון';
    btn.classList.remove('hidden');
    info.classList.add('hidden');
  } else {
    btn.classList.add('hidden');
    info.classList.add('hidden');
  }
}

async function handleInstallClick() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    updateInstallButtonVisibility();
    return;
  }
  if (isIOS()) {
    if (isChromeOnIOS()) {
      await confirmModal(
        'התקנה על אייפון',
        'באייפון רק ספארי יכול להתקין אפליקציות למסך הבית - כרום לא תומך בזה (מגבלה של אפל, לא של האפליקציה). יש להעתיק את הקישור, לפתוח אותו בספארי, ואז ללחוץ על כפתור השיתוף (הריבוע עם החץ למעלה) בתחתית המסך ולבחור "הוסף למסך הבית".',
        'הבנתי'
      );
    } else {
      await confirmModal(
        'התקנה על אייפון',
        'בספארי: לחצי על כפתור השיתוף (הריבוע עם החץ למעלה) בתחתית המסך, גללי למטה ובחרי "הוסף למסך הבית".',
        'הבנתי'
      );
    }
  }
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
  document.getElementById('reportCaregiverSelect').addEventListener('change', (e) => {
    reportCaregiverId = e.target.value;
    renderReport();
  });
  document.getElementById('deductionInput').addEventListener('change', handleDeductionChange);
  document.getElementById('addCaregiverBtn').addEventListener('click', handleAddCaregiver);
  document.getElementById('shareReportBtn').addEventListener('click', handleShareReport);
  document.getElementById('addEntryBtn').addEventListener('click', () => openEntryModal(null));
  document.getElementById('entryCancelBtn').addEventListener('click', closeEntryModal);
  document.getElementById('entrySaveBtn').addEventListener('click', handleSaveEntry);
  document.getElementById('entryDeleteBtn').addEventListener('click', handleDeleteEntry);
  document.getElementById('exportBtn').addEventListener('click', handleExport);
  document.getElementById('importInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = '';
  });
  document.getElementById('resetBtn').addEventListener('click', handleReset);
  document.getElementById('installAppBtn').addEventListener('click', handleInstallClick);
  updateInstallButtonVisibility();

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
