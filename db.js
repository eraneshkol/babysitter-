/*
 * שכבת אחסון - עיצוב "חגורה ושלייקס":
 * 1. IndexedDB הוא מקור האמת הראשי (מכיל הרבה מקום, transactions אמיתיים).
 * 2. אחרי כל כתיבה, כל מצב הדאטא מועתק (mirror) גם ל-localStorage באופן סינכרוני.
 * 3. באתחול האפליקציה, אם אחד המקורות חסר/פגום - משחזרים אותו מהשני אוטומטית.
 * 4. כל כתיבה של רשומה + סטייט מתבצעת באותה טרנזקציה של IndexedDB כדי שלא ייווצר מצב ביניים לא עקבי.
 *
 * מודל: כל מטפלת (caregiver) היא ישות נפרדת עם שם ותעריף, ולה state נפרד (כניסה/יציאה)
 * ורשומות (entries) משויכות אליה דרך caregiverId. גרסה 1 של הסכימה הייתה חד-מטפלתית -
 * migrateLegacyIfNeeded() ממיר דאטא ישן לצורה החדשה בלי לאבד כלום.
 */

const DB_NAME = 'babysitterTrackerDB';
const DB_VERSION = 3;
const MIRROR_KEY = 'babysitter_mirror_v2';

let dbPromise = null;
let legacyCapture = null; // דאטא ישן (סכימת v1) שנתפס בזמן ה-upgrade, לפני שהוא נמחק

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction;
      const oldVersion = e.oldVersion;

      const applySharedSchema = () => {
        // מחליפים את מבנה ה-state רק כשבאמת עולים מסכימת v1 (keyPath 'key') לסכימת v2+
        // (keyPath 'caregiverId'). בכל עדכון סכימה עתידי (v3, v4...) אסור לגעת בסטור הזה,
        // אחרת נמחק בטעות סטייט כניסה/יציאה פעיל של מטפלת אמיתית.
        if (oldVersion < 2) {
          if (db.objectStoreNames.contains('state')) {
            db.deleteObjectStore('state');
          }
          db.createObjectStore('state', { keyPath: 'caregiverId' });
        }

        if (!db.objectStoreNames.contains('caregivers')) {
          db.createObjectStore('caregivers', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('entries')) {
          const es = db.createObjectStore('entries', { keyPath: 'id' });
          es.createIndex('caregiverYearMonth', ['caregiverId', 'yearMonth'], { unique: false });
          es.createIndex('date', 'date', { unique: false });
        } else {
          const es = tx.objectStore('entries');
          if (!es.indexNames.contains('caregiverYearMonth')) {
            es.createIndex('caregiverYearMonth', ['caregiverId', 'yearMonth'], { unique: false });
          }
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('deductions')) {
          db.createObjectStore('deductions', { keyPath: 'id' });
        }
      };

      // אם יש state ישן (סכימת v1, key: 'current') - תופסים אותו לפני שהוא נמחק
      if (oldVersion < 2 && db.objectStoreNames.contains('state')) {
        const os = tx.objectStore('state');
        const r = os.get('current');
        r.onsuccess = () => {
          legacyCapture = { state: r.result || null };
          applySharedSchema();
        };
        r.onerror = () => {
          legacyCapture = { state: null };
          applySharedSchema();
        };
      } else {
        applySharedSchema();
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

function uid(prefix = 'e') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
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
    const tx = db.transaction(['entries', 'state', 'settings', 'caregivers', 'deductions'], 'readonly');
    const result = { entries: [], states: [], settings: [], caregivers: [], deductions: [] };
    tx.objectStore('entries').getAll().onsuccess = (e) => (result.entries = e.target.result);
    tx.objectStore('state').getAll().onsuccess = (e) => (result.states = e.target.result);
    tx.objectStore('settings').getAll().onsuccess = (e) => (result.settings = e.target.result);
    tx.objectStore('caregivers').getAll().onsuccess = (e) => (result.caregivers = e.target.result);
    tx.objectStore('deductions').getAll().onsuccess = (e) => (result.deductions = e.target.result);
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

// --- ממיר צורת גיבוי ישנה (חד-מטפלתית, v1) לצורה החדשה (multi-caregiver, v2) בלי לאבד דאטא ---
function normalizeLegacyBackupShape(raw) {
  if (!raw) return raw;
  if (Array.isArray(raw.caregivers) && Array.isArray(raw.states)) return raw; // כבר בצורה החדשה

  const legacySettingsObj = Array.isArray(raw.settings)
    ? raw.settings.find((s) => s.key === 'settings')
    : raw.settings;

  const defaultCaregiver = {
    id: uid('c'),
    name: 'מטפלת',
    hourlyRate: (legacySettingsObj && legacySettingsObj.hourlyRate) || 0,
    createdAt: new Date().toISOString(),
    archived: false,
  };

  const entries = (raw.entries || []).map((entry) => ({
    ...entry,
    caregiverId: entry.caregiverId || defaultCaregiver.id,
  }));

  const legacyState = raw.state;
  const states = [
    {
      caregiverId: defaultCaregiver.id,
      status: legacyState && legacyState.status === 'in' ? 'in' : 'out',
      activeEntryId: legacyState && legacyState.status === 'in' ? legacyState.activeEntryId : null,
      checkInTimestamp: legacyState && legacyState.status === 'in' ? legacyState.checkInTimestamp : null,
    },
  ];

  return {
    entries,
    states,
    caregivers: [defaultCaregiver],
    settings: [{ key: 'app', activeCaregiverId: defaultCaregiver.id }],
  };
}

// --- שחזור: אם IndexedDB ריק אבל יש mirror -> טוענים ממנו. אם IndexedDB תקין -> מרעננים את ה-mirror ---
async function initAndSelfHeal() {
  const db = await openDb();
  const current = await readAll();
  const hasIdbData =
    current.entries.length > 0 ||
    current.states.length > 0 ||
    current.settings.length > 0 ||
    current.caregivers.length > 0;

  if (!hasIdbData) {
    const mirror = readMirror();
    const mirrorHasData =
      mirror &&
      ((Array.isArray(mirror.entries) && mirror.entries.length) ||
        (Array.isArray(mirror.states) && mirror.states.length) ||
        (Array.isArray(mirror.caregivers) && mirror.caregivers.length) ||
        mirror.state ||
        mirror.settings);
    if (mirrorHasData) {
      await restoreAll(normalizeLegacyBackupShape(mirror));
    }
  }

  await migrateLegacyIfNeeded();
  return await readAll();
}

// --- ממיר דאטא ישן שכבר יושב ב-IndexedDB (סכימת v1) למטפלת ברירת מחדל, פעם אחת בלבד ---
async function migrateLegacyIfNeeded() {
  const db = await openDb();
  const caregivers = await new Promise((resolve, reject) => {
    const tx = db.transaction(['caregivers'], 'readonly');
    const req = tx.objectStore('caregivers').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
  if (caregivers.length > 0) return; // כבר קיימת לפחות מטפלת אחת - שום דבר לעשות

  const legacySettings = await new Promise((resolve) => {
    const tx = db.transaction(['settings'], 'readonly');
    const req = tx.objectStore('settings').get('settings');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });

  const defaultCaregiver = {
    id: uid('c'),
    name: 'מטפלת',
    hourlyRate: (legacySettings && legacySettings.hourlyRate) || 0,
    createdAt: new Date().toISOString(),
    archived: false,
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction(['caregivers', 'entries', 'state'], 'readwrite');
    tx.objectStore('caregivers').add(defaultCaregiver);

    const entriesStore = tx.objectStore('entries');
    const cursorReq = entriesStore.openCursor();
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const entry = cursor.value;
        if (!entry.caregiverId) {
          entry.caregiverId = defaultCaregiver.id;
          cursor.update(entry);
        }
        cursor.continue();
      }
    };

    const stateStore = tx.objectStore('state');
    const ls = legacyCapture && legacyCapture.state;
    stateStore.put({
      caregiverId: defaultCaregiver.id,
      status: ls && ls.status === 'in' ? 'in' : 'out',
      activeEntryId: ls && ls.status === 'in' ? ls.activeEntryId : null,
      checkInTimestamp: ls && ls.status === 'in' ? ls.checkInTimestamp : null,
    });

    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });

  await setActiveCaregiverId(defaultCaregiver.id);
  await mirrorNow();
}

async function restoreAll(data) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state', 'settings', 'caregivers', 'deductions'], 'readwrite');
    tx.objectStore('entries').clear();
    tx.objectStore('state').clear();
    tx.objectStore('settings').clear();
    tx.objectStore('caregivers').clear();
    tx.objectStore('deductions').clear();
    (data.entries || []).forEach((entry) => tx.objectStore('entries').put(entry));
    (data.states || []).forEach((s) => tx.objectStore('state').put(s));
    (data.settings || []).forEach((s) => tx.objectStore('settings').put(s));
    (data.caregivers || []).forEach((c) => tx.objectStore('caregivers').put(c));
    (data.deductions || []).forEach((d) => tx.objectStore('deductions').put(d));
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ==================== מטפלות ====================

async function getAllCaregivers() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['caregivers'], 'readonly');
    const req = tx.objectStore('caregivers').getAll();
    req.onsuccess = () => resolve(req.result.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    req.onerror = (e) => reject(e.target.error);
  });
}

async function addCaregiver(name, hourlyRate) {
  const db = await openDb();
  const caregiver = {
    id: uid('c'),
    name: String(name).trim(),
    hourlyRate: Number(hourlyRate) || 0,
    createdAt: new Date().toISOString(),
    archived: false,
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['caregivers', 'state'], 'readwrite');
    tx.objectStore('caregivers').add(caregiver);
    tx.objectStore('state').put({ caregiverId: caregiver.id, status: 'out', activeEntryId: null, checkInTimestamp: null });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  await mirrorNow();
  return caregiver;
}

async function updateCaregiver(id, { name, hourlyRate } = {}) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['caregivers'], 'readwrite');
    const store = tx.objectStore('caregivers');
    const req = store.get(id);
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (name != null) c.name = String(name).trim();
      if (hourlyRate != null) c.hourlyRate = Number(hourlyRate) || 0;
      store.put(c);
    };
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  await mirrorNow();
}

// מוחקת רק אם אין לה אף רשומה (בטוח); אחרת מעבירה לארכיון כדי לא לאבד היסטוריית תשלומים
async function removeCaregiver(id) {
  const db = await openDb();
  const hasEntries = await new Promise((resolve, reject) => {
    const tx = db.transaction(['entries'], 'readonly');
    const idx = tx.objectStore('entries').index('caregiverYearMonth');
    const range = IDBKeyRange.bound([id, ''], [id, '￿']);
    const req = idx.count(range);
    req.onsuccess = () => resolve(req.result > 0);
    req.onerror = (e) => reject(e.target.error);
  });

  if (hasEntries) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['caregivers'], 'readwrite');
      const store = tx.objectStore('caregivers');
      const req = store.get(id);
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          c.archived = true;
          store.put(c);
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  } else {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['caregivers', 'state'], 'readwrite');
      tx.objectStore('caregivers').delete(id);
      tx.objectStore('state').delete(id);
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  }
  await mirrorNow();
  return { archived: hasEntries };
}

async function getActiveCaregiverId() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['settings'], 'readonly');
    const req = tx.objectStore('settings').get('app');
    req.onsuccess = () => resolve(req.result ? req.result.activeCaregiverId : null);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function setActiveCaregiverId(caregiverId) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['settings'], 'readwrite');
    tx.objectStore('settings').put({ key: 'app', activeCaregiverId: caregiverId });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  await mirrorNow();
}

// ==================== כניסה / יציאה ====================

async function checkIn(caregiverId) {
  const db = await openDb();
  const now = new Date();
  const entry = {
    id: uid(),
    caregiverId,
    date: isoDateOnly(now),
    yearMonth: toYearMonth(isoDateOnly(now)),
    checkIn: now.toISOString(),
    checkOut: null,
    durationMinutes: null,
  };
  const state = { caregiverId, status: 'in', activeEntryId: entry.id, checkInTimestamp: now.toISOString() };

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

async function checkOut(caregiverId) {
  const db = await openDb();
  const now = new Date();

  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state'], 'readwrite');
    const stateStore = tx.objectStore('state');
    const entriesStore = tx.objectStore('entries');

    const getStateReq = stateStore.get(caregiverId);
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
          stateStore.put({ caregiverId, status: 'out', activeEntryId: null, checkInTimestamp: null });
          resolve(null);
          return;
        }
        const checkInDate = new Date(entry.checkIn);
        const durationMinutes = Math.max(0, Math.round((now - checkInDate) / 60000));
        entry.checkOut = now.toISOString();
        entry.durationMinutes = durationMinutes;
        entriesStore.put(entry);
        stateStore.put({ caregiverId, status: 'out', activeEntryId: null, checkInTimestamp: null });
        resolve({ entry });
      };
    };
    tx.onerror = (e) => reject(e.target.error);
  });

  await mirrorNow();
  return result;
}

async function getCurrentState(caregiverId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['state'], 'readonly');
    const req = tx.objectStore('state').get(caregiverId);
    req.onsuccess = () =>
      resolve(req.result || { caregiverId, status: 'out', activeEntryId: null, checkInTimestamp: null });
    req.onerror = (e) => reject(e.target.error);
  });
}

// ==================== דוחות ====================

async function getEntriesForCaregiverMonth(caregiverId, yearMonth) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['entries'], 'readonly');
    const idx = tx.objectStore('entries').index('caregiverYearMonth');
    const req = idx.getAll(IDBKeyRange.only([caregiverId, yearMonth]));
    req.onsuccess = () => {
      const list = req.result.slice().sort((a, b) => a.checkIn.localeCompare(b.checkIn));
      resolve(list);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// ==================== גיבוי / איפוס ====================

async function resetAllData() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['entries', 'state', 'settings', 'caregivers', 'deductions'], 'readwrite');
    tx.objectStore('entries').clear();
    tx.objectStore('state').clear();
    tx.objectStore('settings').clear();
    tx.objectStore('caregivers').clear();
    tx.objectStore('deductions').clear();
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  localStorage.removeItem(MIRROR_KEY);
}

async function getDeduction(caregiverId, yearMonth) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['deductions'], 'readonly');
    const req = tx.objectStore('deductions').get(`${caregiverId}_${yearMonth}`);
    req.onsuccess = () => resolve(req.result ? Number(req.result.amount) || 0 : 0);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function setDeduction(caregiverId, yearMonth, amount) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['deductions'], 'readwrite');
    tx.objectStore('deductions').put({ id: `${caregiverId}_${yearMonth}`, caregiverId, yearMonth, amount: Number(amount) || 0 });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
  await mirrorNow();
}

async function exportBackupObject() {
  return await readAll();
}

async function importBackupObject(raw) {
  if (!raw || !Array.isArray(raw.entries)) {
    throw new Error('קובץ גיבוי לא תקין');
  }
  const isNewShape = Array.isArray(raw.caregivers) && Array.isArray(raw.states);
  if (isNewShape) {
    for (const entry of raw.entries) {
      if (!entry.id || !entry.caregiverId || !entry.date || !entry.yearMonth || !entry.checkIn) {
        throw new Error('קובץ גיבוי לא תקין - רשומה חסרה שדות');
      }
    }
    for (const c of raw.caregivers) {
      if (!c.id || !c.name) throw new Error('קובץ גיבוי לא תקין - מטפלת חסרה שדות');
    }
  } else {
    for (const entry of raw.entries) {
      if (!entry.id || !entry.date || !entry.yearMonth || !entry.checkIn) {
        throw new Error('קובץ גיבוי לא תקין - רשומה חסרה שדות');
      }
    }
  }
  const normalized = normalizeLegacyBackupShape(raw);
  await restoreAll(normalized);
  await mirrorNow();
}

window.DB = {
  initAndSelfHeal,
  getAllCaregivers,
  addCaregiver,
  updateCaregiver,
  removeCaregiver,
  getActiveCaregiverId,
  setActiveCaregiverId,
  checkIn,
  checkOut,
  getCurrentState,
  getEntriesForCaregiverMonth,
  getDeduction,
  setDeduction,
  resetAllData,
  exportBackupObject,
  importBackupObject,
  mirrorNow,
  readAll,
};
