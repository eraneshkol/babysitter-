/*
 * שכבת אחסון - עיצוב "חגורה ושלייקס":
 * 1. IndexedDB הוא מקור האמת הראשי (מכיל הרבה מקום, transactions אמיתיים).
 * 2. אחרי כל כתיבה, כל מצב הדאטא מועתק (mirror) גם ל-localStorage באופן סינכרוני.
 * 3. באתחול האפליקציה, אם אחד המקורות חסר/פגום - משחזרים אותו מהשני אוטומטית.
 * 4. כל כתיבה של רשומה + סטייט מתבצעת באותה טרנזקציה של IndexedDB כדי שלא ייווצר מצב ביניים לא עקבי.
 */

const DB_NAME = 'babysitterTrackerDB';
const DB_VERSION = 1;
const MIRROR_KEY = 'babysitter_mirror_v1';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('yearMonth', 'yearMonth', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('state')) {
        db.createObjectStore('state', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

function uid() {
  return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function toYearMonth(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}

function isoDateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// --- קריאה מלאה של כל הדאטא (לצורך mirror/export) ---
async function readAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state', 'settings'], 'readonly');
    const result = { entries: [], state: null, settings: null };
    tx.objectStore('entries').getAll().onsuccess = (e) => (result.entries = e.target.result);
    tx.objectStore('state').get('current').onsuccess = (e) => (result.state = e.target.result || null);
    tx.objectStore('settings').get('settings').onsuccess = (e) => (result.settings = e.target.result || null);
    tx.oncomplete = () => resolve(result);
    tx.onerror = (e) => reject(e.target.error);
  });
}

function writeMirror(data) {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
    return true;
  } catch (err) {
    console.error('mirror write failed', err);
    return false;
  }
}

function readMirror() {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('mirror read failed', err);
    return null;
  }
}

async function mirrorNow() {
  const data = await readAll();
  writeMirror(data);
  return data;
}

// --- שחזור: אם IndexedDB ריק אבל יש mirror -> טוענים ממנו. אם IndexedDB תקין -> מרעננים את ה-mirror ---
async function initAndSelfHeal() {
  const db = await openDb();
  const current = await readAll();
  const hasIdbData = current.entries.length > 0 || current.state || current.settings;

  if (!hasIdbData) {
    const mirror = readMirror();
    if (mirror && (mirror.entries?.length || mirror.state || mirror.settings)) {
      await restoreAll(mirror);
      return await readAll();
    }
  }
  writeMirror(current);
  return current;
}

async function restoreAll(data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state', 'settings'], 'readwrite');
    tx.objectStore('entries').clear();
    (data.entries || []).forEach((entry) => tx.objectStore('entries').put(entry));
    if (data.state) tx.objectStore('state').put(data.state);
    if (data.settings) tx.objectStore('settings').put(data.settings);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// --- כניסה: יוצר רשומה חדשה + מעדכן סטייט, בטרנזקציה אחת ---
async function checkIn() {
  const db = await openDb();
  const now = new Date();
  const entry = {
    id: uid(),
    date: isoDateOnly(now),
    yearMonth: toYearMonth(isoDateOnly(now)),
    checkIn: now.toISOString(),
    checkOut: null,
    durationMinutes: null,
  };
  const state = { key: 'current', status: 'in', activeEntryId: entry.id, checkInTimestamp: now.toISOString() };

  await new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state'], 'readwrite');
    tx.objectStore('entries').add(entry);
    tx.objectStore('state').put(state);
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });

  await mirrorNow();
  return { entry, state };
}

// --- יציאה: סוגר את הרשומה הפעילה + מעדכן סטייט, בטרנזקציה אחת ---
async function checkOut() {
  const db = await openDb();
  const now = new Date();

  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state'], 'readwrite');
    const stateStore = tx.objectStore('state');
    const entriesStore = tx.objectStore('entries');

    const getStateReq = stateStore.get('current');
    getStateReq.onsuccess = () => {
      const state = getStateReq.result;
      if (!state || state.status !== 'in' || !state.activeEntryId) {
        // אין כניסה פעילה - שום דבר לעדכן (הגנה מפני מצב לא תקין)
        resolve(null);
        return;
      }
      const getEntryReq = entriesStore.get(state.activeEntryId);
      getEntryReq.onsuccess = () => {
        const entry = getEntryReq.result;
        if (!entry) {
          // הרשומה נעלמה - מתקנים סטייט למצב "יציאה" כדי לא להישאר תקועים
          stateStore.put({ key: 'current', status: 'out', activeEntryId: null, checkInTimestamp: null });
          resolve(null);
          return;
        }
        const checkInDate = new Date(entry.checkIn);
        const durationMinutes = Math.max(0, Math.round((now - checkInDate) / 60000));
        entry.checkOut = now.toISOString();
        entry.durationMinutes = durationMinutes;
        entriesStore.put(entry);
        stateStore.put({ key: 'current', status: 'out', activeEntryId: null, checkInTimestamp: null });
        resolve({ entry });
      };
    };
    tx.onerror = (e) => reject(e.target.error);
  });

  await mirrorNow();
  return result;
}

async function getCurrentState() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['state'], 'readonly');
    const req = tx.objectStore('state').get('current');
    req.onsuccess = () => resolve(req.result || { key: 'current', status: 'out', activeEntryId: null, checkInTimestamp: null });
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getEntriesForMonth(yearMonth) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries'], 'readonly');
    const idx = tx.objectStore('entries').index('yearMonth');
    const req = idx.getAll(IDBKeyRange.only(yearMonth));
    req.onsuccess = () => {
      const list = req.result.slice().sort((a, b) => a.checkIn.localeCompare(b.checkIn));
      resolve(list);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getAllMonthsWithData() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries'], 'readonly');
    const req = tx.objectStore('entries').getAll();
    req.onsuccess = () => {
      const months = new Set(req.result.map((e) => e.yearMonth));
      resolve(Array.from(months).sort());
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getSettings() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['settings'], 'readonly');
    const req = tx.objectStore('settings').get('settings');
    req.onsuccess = () => resolve(req.result || { key: 'settings', hourlyRate: 0 });
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveSettings(hourlyRate) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['settings'], 'readwrite');
    tx.objectStore('settings').put({ key: 'settings', hourlyRate });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  await mirrorNow();
}

async function resetAllData() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state', 'settings'], 'readwrite');
    tx.objectStore('entries').clear();
    tx.objectStore('state').clear();
    tx.objectStore('settings').clear();
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  localStorage.removeItem(MIRROR_KEY);
}

async function exportBackupObject() {
  return await readAll();
}

async function importBackupObject(data) {
  if (!data || !Array.isArray(data.entries)) {
    throw new Error('קובץ גיבוי לא תקין');
  }
  for (const e of data.entries) {
    if (!e.id || !e.date || !e.yearMonth || !e.checkIn) {
      throw new Error('קובץ גיבוי לא תקין - רשומה חסרה שדות');
    }
  }
  await restoreAll(data);
  await mirrorNow();
}

window.DB = {
  initAndSelfHeal,
  checkIn,
  checkOut,
  getCurrentState,
  getEntriesForMonth,
  getAllMonthsWithData,
  getSettings,
  saveSettings,
  resetAllData,
  exportBackupObject,
  importBackupObject,
  mirrorNow,
  readAll,
};
