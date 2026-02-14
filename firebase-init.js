// firebase-init.js ✅ (CDN module + exposes window.fb)
// Put this file on your server and load with: <script type="module" src="./firebase-init.js"></script>

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";

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

/* ✅ Must match your localStorage keys */
const LS_PRODUCTS   = "madira_products_v1";
const LS_CATEGORIES = "madira_categories_v1";
const LS_ORDERS     = "madira_orders_v1";

/* ✅ Optional: store separation */
const STORE_ID = "madira_store_1";

/* ------------------ init ------------------ */
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

/* ------------------ firestore paths ------------------ */
const colCats   = () => collection(db, "stores", STORE_ID, "categories");
const colProds  = () => collection(db, "stores", STORE_ID, "products");
const colOrders = () => collection(db, "stores", STORE_ID, "orders");

/* ------------------ helpers ------------------ */
function startOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0); }
function endOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999); }

function safeJSON(str, fallback){ try { return JSON.parse(str); } catch { return fallback; } }

/** Firestore doc IDs cannot contain "/" etc. This keeps your IDs safe. */
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

/* ------------------ AUTH (required for your writes if rules demand auth) ------------------ */
let _authReady = null;

async function ensureAnonAuth(){
  if (auth.currentUser) return auth.currentUser;

  if (_authReady) return _authReady;

  _authReady = (async () => {
    // Wait briefly if auth state is already resolving
    await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, () => { unsub(); resolve(); });
    });

    if (auth.currentUser) return auth.currentUser;

    try {
      await signInAnonymously(auth);
      return auth.currentUser;
    } catch (e) {
      // This is where your current error is coming from.
      // Fix: enable Anonymous sign-in + allow signups + ensure domain/API-key restrictions are correct.
      console.error("Anonymous auth failed:", e?.code, e?.message, e);
      throw e;
    }
  })();

  return _authReady;
}

/* ------------------ write (upsert) ------------------ */
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

async function upsertProduct(product){
  await ensureAnonAuth();
  const rawId = String(product?.id || "").trim();
  if (!rawId) throw new Error("Product id missing");

  const id = toDocId(rawId);
  await setDoc(
    doc(colProds(), id),
    { ...product, id: rawId, updatedAt: serverTimestamp() },
    { merge:true }
  );
}

async function deleteProduct(id){
  await ensureAnonAuth();
  const pid = toDocId(id);
  if (!pid) return;
  await deleteDoc(doc(colProds(), pid));
}

function normalizeOrderForCloud(order){
  const ts = order?.ts ? new Date(order.ts) : new Date();
  return { ...order, ts, updatedAt: new Date() }; // Firestore stores Date as Timestamp
}

async function saveOrder(order){
  await ensureAnonAuth();
  const rid = String(order?.receiptId || "").trim();
  if (!rid) throw new Error("receiptId missing");

  const payload = normalizeOrderForCloud(order);
  await setDoc(doc(colOrders(), rid), payload, { merge:true });
}

/* ------------------ read ------------------ */
async function fetchCategories(){
  await ensureAnonAuth();
  const snap = await getDocs(colCats());
  return snap.docs.map(d => {
    const data = d.data() || {};
    return { id: d.id, name: data.name || d.id, icon: data.icon || "•" };
  });
}

async function fetchProducts(){
  await ensureAnonAuth();
  const snap = await getDocs(colProds());
  return snap.docs.map(d => {
    const data = d.data() || {};
    return { ...data, _docId: d.id, id: data.id || d.id };
  });
}

async function fetchOrdersByDate(fromDate, toDate){
  await ensureAnonAuth();

  let qRef;
  if (fromDate && toDate){
    qRef = query(
      colOrders(),
      where("ts", ">=", Timestamp.fromDate(fromDate)),
      where("ts", "<=", Timestamp.fromDate(toDate)),
      orderBy("ts", "asc")
    );
  } else {
    qRef = query(colOrders(), orderBy("ts", "desc"), limit(2000));
  }

  const snap = await getDocs(qRef);
  return snap.docs.map(d => {
    const data = d.data() || {};
    const ts =
      data.ts?.toDate ? data.ts.toDate() :
      (data.ts instanceof Date ? data.ts : null);

    return {
      id: d.id,
      ...data,
      receiptId: data.receiptId || d.id,
      ts: ts ? ts.toISOString() : ""
    };
  });
}

/* ------------------ sync to localStorage ------------------ */
async function pullAllToLocalStorage(){
  const [cats, prods, orders] = await Promise.all([
    fetchCategories(),
    fetchProducts(),
    fetchOrdersByDate(null, null)
  ]);

  localStorage.setItem(
    LS_CATEGORIES,
    JSON.stringify(cats.map(c => ({ name: c.name, icon: c.icon || "•" })))
  );
  localStorage.setItem(LS_PRODUCTS, JSON.stringify(prods));
  localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
}

/* ------------------ export CSV ------------------ */
async function downloadOrdersCSV(fromISO, toISO){
  const from = fromISO ? startOfDay(new Date(fromISO)) : null;
  const to   = toISO   ? endOfDay(new Date(toISO)) : null;

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
        qty: it.qty || 0,
        unitPrice: it.price || 0,
        lineTotal: (Number(it.price||0) * Number(it.qty||0)),
        orderTotal: o.amount || 0
      });
    });
  });

  const csv = toCSV(flat);
  const labelFrom = fromISO || "ALL";
  const labelTo   = toISO || "ALL";
  downloadText(csv, `madira_orders_${labelFrom}_to_${labelTo}.csv`, "text/csv");
}

/* ✅ Expose to your existing scripts */
window.fb = {
  db,
  auth,
  ensureAnonAuth,
  upsertCategory,
  deleteCategory,
  upsertProduct,
  deleteProduct,
  saveOrder,
  fetchCategories,
  fetchProducts,
  fetchOrdersByDate,
  pullAllToLocalStorage,
  downloadOrdersCSV
};

console.log("✅ Firebase ready:", firebaseConfig.projectId, "STORE_ID:", STORE_ID);
