// firebase-init.js ✅ (MODULE) — FULL COPY-PASTE
// ✅ Reads from NEW path: shops/{SHOP_ID}/...
// ✅ Fallback reads from OLD path: stores/{LEGACY_STORE_ID}/...
// ✅ Exposes window.fb.pullAllToLocalStorage() used by admin.js

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

/* ✅ Firebase config */
const firebaseConfig = {
  apiKey: "AIzaSyA1j5o_xomVeJqIe-mc3cV20kWk780UCvM",
  authDomain: "madira-beer.firebaseapp.com",
  projectId: "madira-beer",
  storageBucket: "madira-beer.firebasestorage.app",
  messagingSenderId: "525337602444",
  appId: "1:525337602444:web:6aa0421af6b6aaa9348ea9",
  measurementId: "G-DN6WLYYWLT"
};

/* ✅ NEW structure (current cashier/admin compat code) */
const SHOP_ID = "madira";

/* ✅ OLD structure (earlier firebase-init.js) — kept so old history still appears */
const LEGACY_STORE_ID = "madira_store_1";

/* ✅ LocalStorage keys */
const LS_PRODUCTS   = "madira_products_v1";
const LS_CATEGORIES = "madira_categories_v1";
const LS_ORDERS     = "madira_orders_v1";
const LS_PURCHASES  = "madira_purchases_v1";

/* ------------------ init ------------------ */
const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

/* ------------------ paths (NEW) ------------------ */
const colCatsNew      = () => collection(db, "shops", SHOP_ID, "categories");
const colProdsNew     = () => collection(db, "shops", SHOP_ID, "products");
const colOrdersNew    = () => collection(db, "shops", SHOP_ID, "orders");
const colPurchNew     = () => collection(db, "shops", SHOP_ID, "purchases");

/* ------------------ paths (OLD fallback) ------------------ */
const colCatsOld      = () => collection(db, "stores", LEGACY_STORE_ID, "categories");
const colProdsOld     = () => collection(db, "stores", LEGACY_STORE_ID, "products");
const colOrdersOld    = () => collection(db, "stores", LEGACY_STORE_ID, "orders");
const colPurchOld     = () => collection(db, "stores", LEGACY_STORE_ID, "purchases");

/* ------------------ helpers ------------------ */
function startOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0); }
function endOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999); }

function toCSV(rows){
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v)=> `"${String(v ?? "").replaceAll('"','""')}"`;
  const head = cols.map(esc).join(",");
  const body = rows.map(r => cols.map(c => esc(r[c])).join(",")).join("\n");
  return head + "\n" + body;
}

function downloadText(text, filename, mime){
  const blob = new Blob([text], {type: mime || "text/plain"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------ AUTH ------------------ */
let _authReady = null;

async function ensureAnonAuth(){
  if (auth.currentUser) return auth.currentUser;
  if (_authReady) return _authReady;

  _authReady = (async () => {
    await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, () => { unsub(); resolve(); });
    });

    if (auth.currentUser) return auth.currentUser;
    await signInAnonymously(auth);
    return auth.currentUser;
  })();

  return _authReady;
}

/* ------------------ generic fetch helpers ------------------ */
async function fetchCategories(){
  await ensureAnonAuth();

  const snapNew = await getDocs(colCatsNew());
  const arrNew = snapNew.docs.map(d => {
    const x = d.data() || {};
    return { name: x.name || d.id, icon: x.icon || "•" };
  });
  if (arrNew.length) return arrNew;

  try{
    const snapOld = await getDocs(colCatsOld());
    return snapOld.docs.map(d => {
      const x = d.data() || {};
      return { name: x.name || d.id, icon: x.icon || "•" };
    });
  } catch {
    return [];
  }
}

async function fetchProducts(){
  await ensureAnonAuth();

  const snapNew = await getDocs(colProdsNew());
  const arrNew = snapNew.docs.map(d => {
    const x = d.data() || {};
    return { ...x, id: x.id || d.id };
  });
  if (arrNew.length) return arrNew;

  try{
    const snapOld = await getDocs(colProdsOld());
    return snapOld.docs.map(d => {
      const x = d.data() || {};
      return { ...x, id: x.id || d.id };
    });
  } catch {
    return [];
  }
}

function normalizeDocWithTs(d){
  const data = d.data() || {};
  const ts = data.ts?.toDate ? data.ts.toDate() : null;
  return { ...data, ts: ts ? ts.toISOString() : (data.tsISO || data.ts || ""), __docId: d.id };
}

async function _fetchByDate(colRef, fromDate, toDate){
  let qRef;
  if (fromDate && toDate){
    qRef = query(
      colRef(),
      where("ts", ">=", Timestamp.fromDate(fromDate)),
      where("ts", "<=", Timestamp.fromDate(toDate)),
      orderBy("ts", "desc"),
      limit(5000)
    );
  } else {
    qRef = query(colRef(), orderBy("ts", "desc"), limit(5000));
  }

  const snap = await getDocs(qRef);
  return snap.docs.map(normalizeDocWithTs);
}

async function fetchOrdersByDate(fromDate, toDate){
  await ensureAnonAuth();

  const listNew = await _fetchByDate(colOrdersNew, fromDate, toDate);
  if (listNew.length) return listNew;

  try { return await _fetchByDate(colOrdersOld, fromDate, toDate); }
  catch { return []; }
}

async function fetchPurchasesByDate(fromDate, toDate){
  await ensureAnonAuth();

  const listNew = await _fetchByDate(colPurchNew, fromDate, toDate);
  if (listNew.length) return listNew;

  try { return await _fetchByDate(colPurchOld, fromDate, toDate); }
  catch { return []; }
}

/* ------------------ sync to localStorage ------------------ */
async function pullAllToLocalStorage(){
  const [cats, prods, orders, purchases] = await Promise.all([
    fetchCategories(),
    fetchProducts(),
    fetchOrdersByDate(null, null),
    fetchPurchasesByDate(null, null)
  ]);

  // Only write non-empty categories/products so defaults are not wiped accidentally.
  if (cats.length) localStorage.setItem(LS_CATEGORIES, JSON.stringify(cats));
  if (prods.length) localStorage.setItem(LS_PRODUCTS, JSON.stringify(prods));

  // Orders/purchases can validly be empty, so write them.
  localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
  localStorage.setItem(LS_PURCHASES, JSON.stringify(purchases));

  return { cats: cats.length, prods: prods.length, orders: orders.length, purchases: purchases.length };
}

/* ------------------ export helpers ------------------ */
async function downloadOrdersCSV(fromISO, toISO){
  const from = fromISO ? startOfDay(new Date(fromISO)) : null;
  const to   = toISO ? endOfDay(new Date(toISO)) : null;
  const orders = await fetchOrdersByDate(from, to);

  const flat = [];
  orders.forEach(o=>{
    (o.items||[]).forEach(it=>{
      flat.push({
        receiptId: o.receiptId || "",
        ts: o.ts || "",
        cashier: o.cashier || "",
        terminal: o.terminal || "",
        method: o.method || "",
        status: o.status || "",
        itemName: it.name || "",
        qty: Number(it.qty||0),
        unitPrice: Number(it.price||0),
        lineTotal: Number(it.price||0) * Number(it.qty||0),
        orderTotal: Number(o.amount||0)
      });
    });
  });

  downloadText(toCSV(flat), `madira_orders_${fromISO || "ALL"}_to_${toISO || "ALL"}.csv`, "text/csv");
}

async function downloadPurchasesCSV(fromISO, toISO){
  const from = fromISO ? startOfDay(new Date(fromISO)) : null;
  const to   = toISO ? endOfDay(new Date(toISO)) : null;
  const purchases = await fetchPurchasesByDate(from, to);

  const flat = [];
  purchases.forEach(p=>{
    (p.items||[]).forEach(it=>{
      flat.push({
        ts: p.ts || "",
        supplier: p.supplier || "",
        invoice: p.invoice || "",
        method: p.method || "",
        addToStock: p.addToStock ? "YES" : "NO",
        product: it.name || "",
        qty: Number(it.qty||0),
        cost: Number(it.cost||0),
        lineTotal: Number(it.lineTotal||0),
        totalPaid: Number(p.totalPaid||0),
        note: p.note || ""
      });
    });
  });

  downloadText(toCSV(flat), `madira_purchases_${fromISO || "ALL"}_to_${toISO || "ALL"}.csv`, "text/csv");
}

/* ✅ Expose */
window.fb = {
  db,
  auth,
  ensureAnonAuth,
  fetchCategories,
  fetchProducts,
  fetchOrdersByDate,
  fetchPurchasesByDate,
  pullAllToLocalStorage,
  downloadOrdersCSV,
  downloadPurchasesCSV
};

console.log("✅ firebase-init ready | NEW shops:", SHOP_ID, "| OLD stores:", LEGACY_STORE_ID);
