// firebase-init.js ✅ FINAL
// Keep this file loaded before admin.js / cashier.js:
// <script type="module" src="firebase-init.js?v=final-1"></script>

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  query,
  orderBy,
  limit,
  where,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA1j5o_xomVeJqIe-mc3cV20kWk780UCvM",
  authDomain: "madira-beer.firebaseapp.com",
  projectId: "madira-beer",
  storageBucket: "madira-beer.firebasestorage.app",
  messagingSenderId: "525337602444",
  appId: "1:525337602444:web:6aa0421af6b6aaa9348ea9",
  measurementId: "G-DN6WLYYWLT"
};

const SHOP_ID = "madira";

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let _authReady = null;

async function ensureAnonAuth(){
  if (auth.currentUser) return auth.currentUser;
  if (_authReady) return _authReady;

  _authReady = (async () => {
    await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, () => {
        unsub();
        resolve();
      });
    });

    if (auth.currentUser) return auth.currentUser;

    await signInAnonymously(auth);
    return auth.currentUser;
  })();

  return _authReady;
}

function startOfDay(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
}

function endOfDay(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999);
}

const refs = {
  categories: () => collection(db, "shops", SHOP_ID, "categories"),
  products: () => collection(db, "shops", SHOP_ID, "products"),
  orders: () => collection(db, "shops", SHOP_ID, "orders"),
  purchases: () => collection(db, "shops", SHOP_ID, "purchases"),
};

async function fetchOrdersByDate(fromDate, toDate){
  await ensureAnonAuth();

  let qRef;
  if (fromDate && toDate){
    qRef = query(
      refs.orders(),
      where("ts", ">=", Timestamp.fromDate(fromDate)),
      where("ts", "<=", Timestamp.fromDate(toDate)),
      orderBy("ts", "desc"),
      limit(5000)
    );
  } else {
    qRef = query(refs.orders(), orderBy("ts", "desc"), limit(5000));
  }

  const snap = await getDocs(qRef);
  return snap.docs.map(d => {
    const x = d.data() || {};
    const tsISO = x.ts?.toDate ? x.ts.toDate().toISOString() : (x.tsISO || x.ts || "");
    return {
      ...x,
      ts: tsISO,
      tsISO,
      __docId: d.id,
      receiptId: x.receiptId || d.id,
      amount: Number(x.amount || 0),
      items: Array.isArray(x.items) ? x.items : [],
      status: x.status || "COMPLETED"
    };
  });
}

async function pullOrdersToLocalStorage(){
  const orders = await fetchOrdersByDate(null, null);
  localStorage.setItem("madira_orders_v1", JSON.stringify(orders));
  return orders;
}

window.fb = {
  app,
  db,
  auth,
  ensureAnonAuth,
  refs,
  fetchOrdersByDate,
  pullOrdersToLocalStorage,
  startOfDay,
  endOfDay
};

console.log("✅ firebase-init ready: shops/" + SHOP_ID);