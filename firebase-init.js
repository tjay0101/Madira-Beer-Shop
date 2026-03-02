// firebase-init.js ✅ (MODULE) — FULL COPY-PASTE
// Loads Modular Firebase SDK safely (no duplicate init)
// Exposes window.fb helpers (optional)
// Uses SAME Firestore structure as cashier/admin compat code:
// shops/{SHOP_ID}/(categories,products,orders,purchases)

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  getDoc,
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

/* ✅ Your Firebase config */
const firebaseConfig = {
  apiKey: "AIzaSyA1j5o_xomVeJqIe-mc3cV20kWk780UCvM",
  authDomain: "madira-beer.firebaseapp.com",
  projectId: "madira-beer",
  storageBucket: "madira-beer.firebasestorage.app",
  messagingSenderId: "525337602444",
  appId: "1:525337602444:web:6aa0421af6b6aaa9348ea9",
  measurementId: "G-DN6WLYYWLT"
};

/* ✅ Must match your actual shop id used in cashier/admin */
const SHOP_ID = "madira";

/* ✅ LocalStorage keys used across app */
const LS_PRODUCTS   = "madira_products_v1";
const LS_CATEGORIES = "madira_categories_v1";
const LS_ORDERS     = "madira_orders_v1";
const LS_PURCHASES  = "madira_purchases_v1";

/* ------------------ init (safe) ------------------ */
const app  = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

/* ------------------ firestore paths ------------------ */
const shopDoc = () => doc(db, "shops", SHOP_ID);
const colCats      = () => collection(db, "shops", SHOP_ID, "categories");
const colProds     = () => collection(db, "shops", SHOP_ID, "products");
const colOrders    = () => collection(db, "shops", SHOP_ID, "orders");
const colPurchases = () => collection(db, "shops", SHOP_ID, "purchases");

/* ------------------ helpers ------------------ */
function startOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0); }
function endOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999); }

function safeJSON(str, fallback){ try { return JSON.parse(str); } catch { return fallback; } }

function toDocId(input){
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

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

/* ------------------ AUTH (anon) ------------------ */
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

/* ------------------ Categories ------------------ */
async function upsertCategory(cat){
  await ensureAnonAuth();
  const name = String(cat?.name || "").trim();
  if (!name) throw new Error("Category name missing");

  const id = toDocId(name);
  await setDoc(
    doc(colCats(), id),
    { name, icon: cat.icon || "•", updatedAt: serverTimestamp() },
    { merge:true }
  );
}

async function deleteCategory(name){
  await ensureAnonAuth();
  const id = toDocId(name);
  if (!id) return;
  await deleteDoc(doc(colCats(), id));
}

/* ------------------ Products ------------------ */
async function upsertProduct(product){
  await ensureAnonAuth();
  const rawId = String(product?.id || "").trim();
  if (!rawId) throw new Error("Product id missing");

  await setDoc(
    doc(colProds(), rawId),
    { ...product, id: rawId, updatedAt: serverTimestamp() },
    { merge:true }
  );
}

async function deleteProduct(id){
  await ensureAnonAuth();
  const pid = String(id || "").trim();
  if (!pid) return;
  await deleteDoc(doc(colProds(), pid));
}

/* ------------------ Orders ------------------ */
async function saveOrder(docIdOrReceiptId, order){
  await ensureAnonAuth();
  const id = String(docIdOrReceiptId || order?.receiptId || "").trim();
  if (!id) throw new Error("Order id missing");

  const tsISO = order?.tsISO || order?.ts || new Date().toISOString();
  const ts = Timestamp.fromDate(new Date(tsISO));

  await setDoc(
    doc(colOrders(), id),
    { ...order, receiptId: order?.receiptId || id, tsISO, ts, updatedAt: serverTimestamp() },
    { merge:true }
  );
}

async function deleteOrder(docId){
  await ensureAnonAuth();
  const id = String(docId || "").trim();
  if (!id) return;
  await deleteDoc(doc(colOrders(), id));
}

/* ------------------ Purchases (NEW) ------------------ */
async function savePurchase(docId, purchase){
  await ensureAnonAuth();
  const id = docId ? String(docId).trim() : null;

  const tsISO = purchase?.tsISO || purchase?.ts || new Date().toISOString();
  const ts = Timestamp.fromDate(new Date(tsISO));

  if (id){
    await setDoc(
      doc(colPurchases(), id),
      { ...purchase, tsISO, ts, updatedAt: serverTimestamp() },
      { merge:true }
    );
    return id;
  } else {
    const auto = doc(colPurchases());
    await setDoc(
      auto,
      { ...purchase, tsISO, ts, createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
      { merge:true }
    );
    return auto.id;
  }
}

async function deletePurchase(docId){
  await ensureAnonAuth();
  const id = String(docId || "").trim();
  if (!id) return;
  await deleteDoc(doc(colPurchases(), id));
}

/* ------------------ reads ------------------ */
async function fetchCategories(){
  await ensureAnonAuth();
  const snap = await getDocs(colCats());
  return snap.docs.map(d => d.data()).filter(Boolean);
}

async function fetchProducts(){
  await ensureAnonAuth();
  const snap = await getDocs(colProds());
  return snap.docs.map(d => d.data()).filter(Boolean);
}

async function fetchOrdersByDate(fromDate, toDate){
  await ensureAnonAuth();

  let qRef;
  if (fromDate && toDate){
    qRef = query(
      colOrders(),
      where("ts", ">=", Timestamp.fromDate(fromDate)),
      where("ts", "<=", Timestamp.fromDate(toDate)),
      orderBy("ts", "desc"),
      limit(5000)
    );
  } else {
    qRef = query(colOrders(), orderBy("ts", "desc"), limit(5000));
  }

  const snap = await getDocs(qRef);
  return snap.docs.map(d => {
    const data = d.data() || {};
    const ts = data.ts?.toDate ? data.ts.toDate() : null;
    return { ...data, ts: ts ? ts.toISOString() : (data.tsISO || ""), __docId: d.id };
  });
}

async function fetchPurchasesByDate(fromDate, toDate){
  await ensureAnonAuth();

  let qRef;
  if (fromDate && toDate){
    qRef = query(
      colPurchases(),
      where("ts", ">=", Timestamp.fromDate(fromDate)),
      where("ts", "<=", Timestamp.fromDate(toDate)),
      orderBy("ts", "desc"),
      limit(5000)
    );
  } else {
    qRef = query(colPurchases(), orderBy("ts", "desc"), limit(5000));
  }

  const snap = await getDocs(qRef);
  return snap.docs.map(d => {
    const data = d.data() || {};
    const ts = data.ts?.toDate ? data.ts.toDate() : null;
    return { ...data, ts: ts ? ts.toISOString() : (data.tsISO || ""), __docId: d.id };
  });
}

/* ------------------ sync to localStorage ------------------ */
async function pullAllToLocalStorage(){
  const [cats, prods, orders, purchases] = await Promise.all([
    fetchCategories(),
    fetchProducts(),
    fetchOrdersByDate(null, null),
    fetchPurchasesByDate(null, null)
  ]);

  localStorage.setItem(LS_CATEGORIES, JSON.stringify(cats));
  localStorage.setItem(LS_PRODUCTS, JSON.stringify(prods));
  localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
  localStorage.setItem(LS_PURCHASES, JSON.stringify(purchases));
}

/* ------------------ export CSV helpers ------------------ */
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

  const csv = toCSV(flat);
  const labelFrom = fromISO || "ALL";
  const labelTo = toISO || "ALL";
  downloadText(csv, `madira_purchases_${labelFrom}_to_${labelTo}.csv`, "text/csv");
}

/* ✅ Expose to your existing scripts (optional usage) */
window.fb = {
  app,
  db,
  auth,
  shopDoc,
  ensureAnonAuth,

  upsertCategory,
  deleteCategory,
  upsertProduct,
  deleteProduct,

  saveOrder,
  deleteOrder,

  savePurchase,
  deletePurchase,

  fetchCategories,
  fetchProducts,
  fetchOrdersByDate,
  fetchPurchasesByDate,

  pullAllToLocalStorage,
  downloadPurchasesCSV
};

console.log("✅ Firebase-init ready:", firebaseConfig.projectId, "SHOP_ID:", SHOP_ID);