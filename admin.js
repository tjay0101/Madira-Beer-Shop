/* =========================================================
   ✅ MADIRA ADMIN.JS (FULL COPY-PASTE) — UPDATED
   ✅ Includes:
   - Existing Admin (Products/Categories/Orders/Reports/Settings)
   - ✅ Stock Purchases (inward) separate from Sales
   - ✅ Barcode scan in Purchases:
       • If barcode matches existing product => auto-select
       • If barcode is new => link it to an existing product (adds to previous stock)
       • Supports product.barcodes[] aliases + product.barcode primary
   ========================================================= */

/* =========================================================
   STORAGE KEYS (MUST MATCH CASHIER)
   ========================================================= */
const LS_PRODUCTS   = "madira_products_v1";
const LS_CATEGORIES = "madira_categories_v1";
const LS_ORDERS     = "madira_orders_v1";
const LS_PURCHASES  = "madira_purchases_v1"; // ✅ NEW (Stock Purchases)
const LS_AUTH       = "madira_auth_v1";

/* =========================================================
   DEFAULTS
   ========================================================= */
const DEFAULT_CATEGORIES = [
  { name:"Beers", icon:"🍺" },
  { name:"Wines", icon:"🍷" },
  { name:"Energy Drinks", icon:"⚡" },
  { name:"Soft Drinks", icon:"🥤" },
  { name:"Snacks", icon:"🍿" },
];

const DEFAULT_PRODUCTS = [];
const LOW_STOCK_DEFAULT = 10;

/* =========================================================
   ✅ LOGOUT (single handler)
   ========================================================= */
const LOGOUT_REDIRECT = "./login.html"; // change to "/login.html" if root

function hardLogout() {
  const KEYS = [
    "bs_auth_session",
    "bs_user",
    "dv_user",
    "dv_profile",
    "dv_saved_info",
    "madira_auth_v1",
    "madira_auth_session",
    "madira_session",
    "auth_session",
    "auth",
    "session",
  ];

  try {
    KEYS.forEach((k) => localStorage.removeItem(k));
    KEYS.forEach((k) => sessionStorage.removeItem(k));
  } catch {}

  try {
    document.cookie.split(";").forEach((c) => {
      const name = c.split("=")[0].trim();
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    });
  } catch {}

  window.location.replace(LOGOUT_REDIRECT);
}

document.addEventListener(
  "click",
  (e) => {
    const btn =
      e.target.closest("#btnLogout") ||
      e.target.closest("[data-logout]") ||
      e.target.closest(".btnLogout");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    hardLogout();
  },
  true
);

/* =========================================================
   ✅ FIREBASE (AUTO-LOAD COMPAT CDN + REALTIME SYNC)
   ========================================================= */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA1j5o_xomVeJqIe-mc3cV20kWk780UCvM",
  authDomain: "madira-beer.firebaseapp.com",
  projectId: "madira-beer",
  storageBucket: "madira-beer.firebasestorage.app",
  messagingSenderId: "525337602444",
  appId: "1:525337602444:web:6aa0421af6b6aaa9348ea9",
  measurementId: "G-DN6WLYYWLT"
};

const FIREBASE_CDN_VERSION = "12.9.0";
const FIREBASE_SHOP_ID     = "madira";

let FB = {
  enabled: false,
  db: null,
  auth: null,
  uid: null,
  unsub: { cats:null, prods:null, orders:null, staff:null, purchases:null }
};

function _loadScriptOnce(src){
  return new Promise((resolve, reject) => {
    const exists = [...document.scripts].some(s => s.src === src);
    if (exists) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load: " + src));
    document.head.appendChild(s);
  });
}

async function ensureFirebaseCompatLoaded(){
  if (window.firebase && firebase.apps) return;
  const v = FIREBASE_CDN_VERSION;
  await _loadScriptOnce(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
  await _loadScriptOnce(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);
  await _loadScriptOnce(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
}

function _shopRef(){ return FB.db.collection("shops").doc(FIREBASE_SHOP_ID); }
function _catsRef(){ return _shopRef().collection("categories"); }
function _prodsRef(){ return _shopRef().collection("products"); }
function _ordersRef(){ return _shopRef().collection("orders"); }
function _purchasesRef(){ return _shopRef().collection("purchases"); } // ✅ NEW
function _staffRef(){ return _shopRef().collection("staff"); }

async function fbInitAndSync(){
  try{
    await ensureFirebaseCompatLoaded();
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);

    FB.auth = firebase.auth();
    FB.db   = firebase.firestore();

    if (!FB.auth.currentUser){
      await FB.auth.signInAnonymously();
    }
    FB.uid = FB.auth.currentUser?.uid || null;
    FB.enabled = true;

    await fbBootstrapIfEmpty();
    fbStartRealtimeSync();

    return true;
  } catch (e){
    console.warn("Firebase disabled (fallback to LocalStorage). Reason:", e);
    FB.enabled = false;
    return false;
  }
}

async function fbBootstrapIfEmpty(){
  const catsSnap   = await _catsRef().limit(1).get();
  const prodsSnap  = await _prodsRef().limit(1).get();
  const ordersSnap = await _ordersRef().limit(1).get();
  const purSnap    = await _purchasesRef().limit(1).get();

  const catsLocal   = safeJSON(localStorage.getItem(LS_CATEGORIES), DEFAULT_CATEGORIES) || DEFAULT_CATEGORIES;
  const prodsLocal  = safeJSON(localStorage.getItem(LS_PRODUCTS), DEFAULT_PRODUCTS) || DEFAULT_PRODUCTS;
  const ordersLocal = safeJSON(localStorage.getItem(LS_ORDERS), []) || [];
  const purLocal    = safeJSON(localStorage.getItem(LS_PURCHASES), []) || [];

  const tsFromISO = (iso) => {
    try { return firebase.firestore.Timestamp.fromDate(new Date(iso)); } catch { return null; }
  };

  if (catsSnap.empty && Array.isArray(catsLocal) && catsLocal.length){
    const batch = FB.db.batch();
    catsLocal.forEach(c => {
      const id = catIdFromName(c.name);
      batch.set(_catsRef().doc(id), {
        name:c.name, icon:c.icon||"•",
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
    });
    await batch.commit();
  }

  if (prodsSnap.empty && Array.isArray(prodsLocal) && prodsLocal.length){
    const batch = FB.db.batch();
    prodsLocal.forEach(p => {
      if (!p?.id) return;
      batch.set(_prodsRef().doc(p.id), {
        ...p,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
    });
    await batch.commit();
  }

  if (ordersSnap.empty && Array.isArray(ordersLocal) && ordersLocal.length){
    const batch = FB.db.batch();
    ordersLocal.slice(0,5000).forEach(o => {
      const docId = `${o.receiptId || "POS"}_${String(o.ts||"").replace(/[:.]/g,"-") || Date.now()}`;
      batch.set(_ordersRef().doc(docId), {
        ...o,
        tsISO: o.ts || "",
        ts: tsFromISO(o.ts) || firebase.firestore.FieldValue.serverTimestamp(),
        importedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
    });
    await batch.commit();
  }

  if (purSnap.empty && Array.isArray(purLocal) && purLocal.length){
    const batch = FB.db.batch();
    purLocal.slice(0,5000).forEach(p => {
      const tsISO = p.ts || p.tsISO || new Date().toISOString();
      const docId = p.__docId && String(p.__docId).startsWith("local_")
        ? `import_${Date.now()}_${Math.random().toString(16).slice(2)}`
        : (p.__docId || `import_${Date.now()}_${Math.random().toString(16).slice(2)}`);

      batch.set(_purchasesRef().doc(docId), {
        supplier: p.supplier || "",
        invoice: p.invoice || "",
        method: p.method || "CASH",
        note: p.note || "",
        items: Array.isArray(p.items) ? p.items : [],
        totalPaid: Number(p.totalPaid || 0),
        addToStock: !!p.addToStock,
        tsISO,
        ts: tsFromISO(tsISO) || firebase.firestore.FieldValue.serverTimestamp(),
        importedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
    });
    await batch.commit();
  }
}

function fbStartRealtimeSync(){
  try{ FB.unsub.cats?.(); } catch {}
  try{ FB.unsub.prods?.(); } catch {}
  try{ FB.unsub.orders?.(); } catch {}
  try{ FB.unsub.purchases?.(); } catch {}

  FB.unsub.cats = _catsRef().onSnapshot((snap)=>{
    const cats = snap.docs.map(d => d.data()).filter(Boolean);
    localStorage.setItem(LS_CATEGORIES, JSON.stringify(cats));
    if (state.route === "inventory") renderInventory();
    if (state.route === "addProduct") renderAddProductPage();
    if (state.route === "settings") renderSettings();
  });

  FB.unsub.prods = _prodsRef().onSnapshot((snap)=>{
    const prods = snap.docs.map(d => d.data()).filter(Boolean);
    localStorage.setItem(LS_PRODUCTS, JSON.stringify(prods));
    if (state.route === "inventory") renderInventory();
    if (state.route === "dashboard") renderDashboard();
    if (state.route === "reports") renderReports();
    if (state.route === "purchases") {
      renderPurchaseProductSelect();
      renderPurchaseDraft();
      renderPurchases();
    }
  });

  FB.unsub.orders = _ordersRef()
    .orderBy("ts", "desc")
    .limit(5000)
    .onSnapshot((snap)=>{
      const orders = snap.docs.map(d => {
        const x = d.data() || {};
        const tsISO = x.ts?.toDate ? x.ts.toDate().toISOString() : (x.tsISO || x.ts || "");
        return { ...x, ts: tsISO, __docId: d.id };
      });
      localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
      if (state.route === "orders") renderOrders();
      if (state.route === "reports") renderReports();
      if (state.route === "dashboard") renderDashboard();
    });

  FB.unsub.purchases = _purchasesRef()
    .orderBy("ts", "desc")
    .limit(5000)
    .onSnapshot((snap)=>{
      const list = snap.docs.map(d => {
        const x = d.data() || {};
        const tsISO = x.ts?.toDate ? x.ts.toDate().toISOString() : (x.tsISO || x.ts || "");
        return { ...x, ts: tsISO, __docId: d.id };
      });
      localStorage.setItem(LS_PURCHASES, JSON.stringify(list));
      if (state.route === "purchases") renderPurchases();
    });
}

/* ============================
   Sync helpers
   ============================ */
function catIdFromName(name){
  return String(name||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,50) || "cat";
}

async function fbSyncCategories(prevCats, nextCats){
  if (!FB.enabled) return;

  const prevIds = new Set((prevCats||[]).map(c=>catIdFromName(c?.name)).filter(Boolean));
  const nextIds = new Set((nextCats||[]).map(c=>catIdFromName(c?.name)).filter(Boolean));

  const batch = FB.db.batch();

  (nextCats||[]).forEach(c=>{
    const id = catIdFromName(c?.name);
    if (!id) return;
    batch.set(_catsRef().doc(id), {
      name:c.name,
      icon:c.icon||"•",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });
  });

  [...prevIds].forEach(id=>{
    if (!nextIds.has(id)){
      batch.delete(_catsRef().doc(id));
    }
  });

  await batch.commit();
}

async function fbSyncProducts(prevProds, nextProds){
  if (!FB.enabled) return;

  const prevIds = new Set((prevProds||[]).map(p=>p?.id).filter(Boolean));
  const nextIds = new Set((nextProds||[]).map(p=>p?.id).filter(Boolean));

  const batch = FB.db.batch();

  (nextProds||[]).forEach(p=>{
    if (!p?.id) return;
    batch.set(_prodsRef().doc(p.id), {
      ...p,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });
  });

  [...prevIds].forEach(id=>{
    if (!nextIds.has(id)){
      batch.delete(_prodsRef().doc(id));
    }
  });

  await batch.commit();
}

/* =========================================================
   STATE
   ========================================================= */
let state = {
  route: "dashboard",
  globalSearch: "",

  invSearch: "",
  invCat: "",
  invStatus: "",

  ordSearch: "",
  ordCashier: "",
  ordStatus: "",
  ordPreset: "today",
  ordFrom: "",
  ordTo: "",

  repPreset: "all",
  repFrom: "",
  repTo: "",

  editProductId: null,
  trendMode: "weekly",

  // Purchases
  purSearch: "",
  purPreset: "all",
  purFrom: "",
  purTo: "",
};

let imageDataURL = null;

/* =========================================================
   BOOT
   ========================================================= */
document.addEventListener("DOMContentLoaded", () => boot().catch(console.error));

async function boot(){
  seedIfMissing();
  await fbInitAndSync();

  bindSidebarNav();
  bindTopbarSearch();
  bindQuickActions();

  bindInventoryControls();
  bindAddProductForm();
  bindOrdersControls();
  bindReportsControls();
  bindSettingsControls();
  bindModalControls();

  // ✅ Purchases
  bindPurchasesControls();

  hydrateAdminIdentity();
  navigate("dashboard");
}

/* =========================================================
   STORAGE HELPERS
   ========================================================= */
function seedIfMissing(){
  const cats = safeJSON(localStorage.getItem(LS_CATEGORIES), null);
  if (!cats || !Array.isArray(cats) || cats.length === 0){
    localStorage.setItem(LS_CATEGORIES, JSON.stringify(DEFAULT_CATEGORIES));
  }

  const prods = safeJSON(localStorage.getItem(LS_PRODUCTS), null);
  if (!prods || !Array.isArray(prods)){
    localStorage.setItem(LS_PRODUCTS, JSON.stringify(DEFAULT_PRODUCTS));
  }

  const orders = safeJSON(localStorage.getItem(LS_ORDERS), null);
  if (!orders || !Array.isArray(orders)){
    localStorage.setItem(LS_ORDERS, JSON.stringify([]));
  }

  const purchases = safeJSON(localStorage.getItem(LS_PURCHASES), null);
  if (!purchases || !Array.isArray(purchases)){
    localStorage.setItem(LS_PURCHASES, JSON.stringify([]));
  }
}

function getCategories(){
  const cats = safeJSON(localStorage.getItem(LS_CATEGORIES), DEFAULT_CATEGORIES);
  return Array.isArray(cats) ? cats : DEFAULT_CATEGORIES;
}
function setCategories(cats){
  const prev = getCategories();
  const next = Array.isArray(cats) ? cats : [];
  localStorage.setItem(LS_CATEGORIES, JSON.stringify(next));

  if (FB.enabled){
    fbSyncCategories(prev, next).catch((e)=>{
      console.warn("fbSyncCategories failed:", e);
      alert("Firebase category save failed. Open console (F12) for details.");
    });
  }
}

function getProducts(){
  const prods = safeJSON(localStorage.getItem(LS_PRODUCTS), DEFAULT_PRODUCTS);
  return Array.isArray(prods) ? prods : DEFAULT_PRODUCTS;
}
function setProducts(prods){
  const prev = getProducts();
  const next = Array.isArray(prods) ? prods : [];
  localStorage.setItem(LS_PRODUCTS, JSON.stringify(next));

  if (FB.enabled){
    fbSyncProducts(prev, next).catch((e)=>{
      console.warn("fbSyncProducts failed:", e);
      alert("Firebase product save/delete failed. Open console (F12) for details.");
    });
  }
}

function getOrders(){
  const orders = safeJSON(localStorage.getItem(LS_ORDERS), []);
  return Array.isArray(orders) ? orders : [];
}

function getPurchases(){
  const list = safeJSON(localStorage.getItem(LS_PURCHASES), []);
  return Array.isArray(list) ? list : [];
}
function setPurchases(list){
  localStorage.setItem(LS_PURCHASES, JSON.stringify(Array.isArray(list) ? list : []));
}

/* =========================================================
   GST/TAX helpers (reports uses order.amount only)
   ========================================================= */
function num(x){ const n = Number(x); return isFinite(n) ? n : 0; }

function orderSubtotal(o){
  if (isFinite(Number(o?.subtotal))) return Number(o.subtotal);
  const items = Array.isArray(o?.items) ? o.items : [];
  if (items.length){
    return items.reduce((s,it)=> s + (num(it.price)*num(it.qty)), 0);
  }
  const amt = num(o?.amount);
  const tax = num(o?.tax);
  return isFinite(amt - tax) ? (amt - tax) : 0;
}

function orderTax(o){
  if (isFinite(Number(o?.tax))) return Number(o.tax);
  const items = Array.isArray(o?.items) ? o.items : [];
  if (items.length){
    return items.reduce((s,it)=>{
      const line = num(it.price)*num(it.qty);
      const r = num(it.gstRate);
      return s + (line * r / 100);
    }, 0);
  }
  return 0;
}

/* =========================================================
   NAVIGATION
   ========================================================= */
function bindSidebarNav(){
  document.querySelectorAll(".navItem").forEach(btn=>{
    btn.addEventListener("click", ()=> navigate(btn.dataset.route));
  });
}

function navigate(route){
  state.route = route;

  document.querySelectorAll(".navItem").forEach(b=>{
    b.classList.toggle("active", b.dataset.route === route);
  });

  document.querySelectorAll(".route").forEach(r=> r.classList.remove("active"));
  const active = document.getElementById(`route-${route}`);
  if (active) active.classList.add("active");

  const crumb = document.getElementById("crumb");
  if (crumb){
    crumb.textContent =
      route === "addProduct" ? "Inventory / Add Product" :
      route === "inventory" ? "Inventory / Stock" :
      route === "purchases" ? "Stock Purchases" :
      route.charAt(0).toUpperCase() + route.slice(1);
  }

  forceAllTableHeaders();

  if (route === "dashboard") renderDashboard();
  if (route === "inventory") renderInventory();
  if (route === "addProduct") renderAddProductPage();
  if (route === "orders") renderOrders();
  if (route === "reports") renderReports();
  if (route === "settings") renderSettings();
  if (route === "purchases") renderPurchases();
}

/* =========================================================
   TOP SEARCH
   ========================================================= */
function bindTopbarSearch(){
  const inp = document.getElementById("globalSearch");
  if (!inp) return;
  inp.addEventListener("input", ()=>{
    state.globalSearch = inp.value.trim().toLowerCase();
    if (state.route === "inventory") renderInventory();
    if (state.route === "orders") renderOrders();
    if (state.route === "dashboard") renderDashboard();
    if (state.route === "reports") renderReports();
    if (state.route === "purchases") renderPurchases();
  });
}

/* =========================================================
   GRID FIX
   ========================================================= */
function forceGrid(el, cols){
  if (!el) return;
  el.style.display = "grid";
  el.style.gridTemplateColumns = cols;
  el.style.alignItems = "center";
  el.style.gap = "12px";
}

function forceAllTableHeaders(){
  forceGrid(document.querySelector("#route-dashboard .table .thead"),
            "0.8fr 0.8fr 1.6fr 0.6fr 0.6fr 0.4fr");
  forceGrid(document.querySelector("#route-inventory .table .thead"),
            "2.2fr 1fr 0.7fr 0.6fr 0.8fr 0.7fr");
  forceGrid(document.querySelector("#route-orders .table .thead"),
            "1fr 1.1fr 1.7fr 0.8fr 0.8fr 0.8fr 0.7fr");
  forceGrid(document.querySelector("#route-reports .table .thead"),
            "0.6fr 1.6fr 1fr 0.7fr 0.9fr");

  // purchases (if exists)
  forceGrid(document.querySelector("#purDraftHead"), "1.6fr 0.6fr 0.7fr 0.8fr 0.5fr");
  forceGrid(document.querySelector("#purTableHead"), "0.9fr 1.4fr 0.9fr 0.7fr 0.8fr 0.7fr 0.6fr");
}

/* =========================================================
   DASHBOARD
   ========================================================= */
function bindQuickActions(){
  document.getElementById("qaAddProduct")?.addEventListener("click", ()=> navigate("addProduct"));
  document.getElementById("qaInventory")?.addEventListener("click", ()=> navigate("inventory"));
  document.getElementById("qaExportOrders")?.addEventListener("click", exportOrdersCSV);
  document.getElementById("btnViewAllOrders")?.addEventListener("click", ()=> navigate("orders"));

  document.querySelectorAll(".segBtn").forEach(b=>{
    b.addEventListener("click", ()=>{
      document.querySelectorAll(".segBtn").forEach(x=>x.classList.remove("active"));
      b.classList.add("active");
      state.trendMode = b.dataset.trend || "weekly";
      renderDashboard();
    });
  });
}

function renderDashboard(){
  forceAllTableHeaders();

  const orders = getOrders();
  const todayKey = isoDateKey(new Date());
  const todays = orders.filter(o => (o.ts||"").slice(0,10) === todayKey);

  const todayRevenue = todays.reduce((s,o)=> s + num(o.amount), 0);
  const tx = todays.length;
  const avg = tx ? todayRevenue/tx : 0;

  setText("kpiTodayRevenue", money(todayRevenue));
  setText("kpiTodayTx", String(tx));
  setText("kpiAvgTicket", `Avg ${money(avg)} per ticket`);

  const prods = getProducts();
  const low = prods.filter(p => num(p.stock) > 0 && num(p.stock) <= num(p.lowStock||LOW_STOCK_DEFAULT));
  const out = prods.filter(p => num(p.stock) === 0);
  const lowCount = low.length + out.length;

  setText("kpiLowCount", String(lowCount));
  setText("kpiLowLabel", `${lowCount} Items`);

  const critWrap = document.getElementById("criticalLowList");
  if (critWrap){
    critWrap.innerHTML = "";
    const crit = [...out, ...low].slice(0,6);
    if (crit.length === 0){
      critWrap.innerHTML = `<div class="smallMuted">No low stock items 🎉</div>`;
    } else {
      crit.forEach(p=>{
        const div = document.createElement("div");
        div.className = "miniItem";
        div.innerHTML = `
          <div class="l">
            <div class="t">${escapeHtml(p.name)}</div>
            <div class="s">${escapeHtml(p.category)} • Stock ${num(p.stock)}</div>
          </div>
          <button class="btn ghost" data-restock="${escapeAttr(p.id)}">Restock</button>
        `;
        div.querySelector("[data-restock]")?.addEventListener("click", ()=> openRestockModal(p.id));
        critWrap.appendChild(div);
      });
    }
  }

  const dashBody = document.getElementById("dashOrdersBody");
  if (dashBody){
    dashBody.innerHTML = "";
    const list = orders.slice(0,6);

    list.forEach(o=>{
      const itemsText = (o.items||[]).slice(0,2).map(i=>`${i.qty}x ${i.name}`).join(", ")
        + ((o.items||[]).length > 2 ? `, +${(o.items||[]).length-2} more` : "");

      const row = document.createElement("div");
      row.className = "trow";
      forceGrid(row, "0.8fr 0.8fr 1.6fr 0.6fr 0.6fr 0.4fr");

      row.innerHTML = `
        <div>${escapeHtml(o.receiptId || "#—")}</div>
        <div>${escapeHtml(o.timeLabel || fmtTime(o.ts))}</div>
        <div style="opacity:.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${escapeHtml(itemsText || "—")}
        </div>
        <div>${money(num(o.amount))}</div>
        <div>${statusBadge(o.status || "COMPLETED")}</div>
        <div class="rowActions" style="display:flex; justify-content:flex-end;">
          <button class="iconBtn" title="View">👁</button>
        </div>
      `;
      row.querySelector(".iconBtn")?.addEventListener("click", ()=> alert(orderDetailsText(o)));
      dashBody.appendChild(row);
    });
  }

  drawTrendChart();
}

function drawTrendChart(){
  const c = document.getElementById("trendCanvas");
  if (!c) return;
  const ctx = c.getContext("2d");
  const orders = getOrders();

  const days = 7;
  const now = new Date();
  const labels = [];
  const vals = [];

  for (let i=days-1;i>=0;i--){
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = isoDateKey(d);
    labels.push(d.toLocaleDateString("en-IN", { weekday:"short" }));
    const revenue = orders
      .filter(o => (o.ts||"").slice(0,10) === key)
      .reduce((s,o)=> s + num(o.amount), 0);
    vals.push(revenue);
  }

  ctx.clearRect(0,0,c.width,c.height);

  const padL = 40, padR = 20, padT = 20, padB = 40;
  const w = c.width - padL - padR;
  const h = c.height - padT - padB;
  const max = Math.max(...vals, 1);

  ctx.strokeStyle = "rgba(17,24,39,.10)";
  ctx.lineWidth = 1;
  for (let i=0;i<=4;i++){
    const y = padT + (h*(i/4));
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL+w, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(37,99,235,.95)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  vals.forEach((v, idx)=>{
    const x = padL + (w * (idx/(vals.length-1 || 1)));
    const y = padT + h - (h*(v/max));
    if (idx===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  ctx.fillStyle = "rgba(37,99,235,.95)";
  vals.forEach((v, idx)=>{
    const x = padL + (w * (idx/(vals.length-1 || 1)));
    const y = padT + h - (h*(v/max));
    ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill();
  });

  ctx.fillStyle = "rgba(17,24,39,.65)";
  ctx.font = "12px ui-sans-serif, system-ui";
  labels.forEach((t, idx)=>{
    const x = padL + (w * (idx/(labels.length-1 || 1)));
    ctx.fillText(t, x-12, padT+h+26);
  });
}

/* =========================================================
   INVENTORY
   ========================================================= */
function bindInventoryControls(){
  document.getElementById("btnGoAddProduct")?.addEventListener("click", ()=> navigate("addProduct"));

  document.getElementById("invSearch")?.addEventListener("input", (e)=>{
    state.invSearch = e.target.value.trim().toLowerCase();
    renderInventory();
  });

  document.getElementById("invCategoryFilter")?.addEventListener("change", (e)=>{
    state.invCat = e.target.value;
    renderInventory();
  });

  document.getElementById("invStatusFilter")?.addEventListener("change", (e)=>{
    state.invStatus = e.target.value;
    renderInventory();
  });
}

function renderInventory(){
  forceAllTableHeaders();

  const cats = getCategories();
  const prods = getProducts();

  const dd = document.getElementById("invCategoryFilter");
  if (dd){
    dd.innerHTML = `<option value="">All Categories</option>` +
      cats.map(c=>`<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)}</option>`).join("");
    if (state.invCat) dd.value = state.invCat;
  }

  setText("invTotalProducts", String(prods.length));
  const low = prods.filter(p => num(p.stock) > 0 && num(p.stock) <= num(p.lowStock||LOW_STOCK_DEFAULT));
  const out = prods.filter(p => num(p.stock) === 0);
  setText("invLowStock", String(low.length + out.length));
  const invVal = prods.reduce((s,p)=> s + (num(p.price) * num(p.stock)), 0);
  setText("invValue", money(invVal));

  let list = [...prods];

  const q = ((state.invSearch || state.globalSearch) || "").trim().toLowerCase();
  if (q){
    list = list.filter(p=>{
      const hay = `${p.id} ${p.name} ${p.barcode} ${(Array.isArray(p.barcodes)?p.barcodes.join(" "):"")} ${p.category}`.toLowerCase();
      return hay.includes(q);
    });
  }

  if (state.invCat){
    list = list.filter(p => p.category === state.invCat);
  }

  if (state.invStatus){
    list = list.filter(p=>{
      const st = stockStatus(p);
      if (state.invStatus === "instock") return st === "In Stock";
      if (state.invStatus === "low") return st === "Low Stock";
      if (state.invStatus === "out") return st === "Out of Stock";
      return true;
    });
  }

  const body = document.getElementById("invBody");
  if (!body) return;

  body.innerHTML = "";
  list.forEach(p=>{
    const row = document.createElement("div");
    row.className = "trow invHead";
    forceGrid(row, "2.2fr 1fr 0.7fr 0.6fr 0.8fr 0.7fr");

    const st = stockStatus(p);
    const badge =
      st === "In Stock" ? `<span class="badge green">In Stock</span>` :
      st === "Low Stock" ? `<span class="badge amber">Low Stock</span>` :
      `<span class="badge red">Out of Stock</span>`;

    row.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center;">
        <div style="width:42px;height:42px;border-radius:14px;border:1px solid rgba(17,24,39,.08);background:rgba(37,99,235,.06);display:grid;place-items:center;font-weight:1000;color:#1d4ed8;">
          ${escapeHtml((p.name||"P")[0] || "P")}
        </div>
        <div>
          <div style="font-weight:1000">${escapeHtml(p.name)}</div>
          <div style="font-size:12px;color:rgba(17,24,39,.6)">Barcode: ${escapeHtml(p.barcode||"—")} • ${escapeHtml(p.size||"")}</div>
          ${Array.isArray(p.barcodes) && p.barcodes.length ? `<div style="font-size:12px;color:rgba(17,24,39,.55)">Other Barcodes: ${escapeHtml(p.barcodes.slice(0,3).join(", "))}${p.barcodes.length>3?"...":""}</div>` : ``}
        </div>
      </div>
      <div>${escapeHtml(p.category || "—")}</div>
      <div>${money(num(p.price))}</div>
      <div>${Math.floor(num(p.stock))}</div>
      <div>${badge}</div>
      <div class="rowActions" style="display:flex; justify-content:flex-end; gap:10px;">
        <button class="iconBtn" title="Edit" data-edit="${escapeAttr(p.id)}">✎</button>
        <button class="iconBtn" title="Restock" data-restock="${escapeAttr(p.id)}">＋</button>
      </div>
    `;

    row.querySelector("[data-edit]")?.addEventListener("click", ()=> openEditProductModal(p.id));
    row.querySelector("[data-restock]")?.addEventListener("click", ()=> openRestockModal(p.id));

    body.appendChild(row);
  });

  setText("invFoot", `Showing ${list.length} of ${prods.length}`);
}

/* =========================================================
   ADD PRODUCT (kept as-is from your setup)
   ========================================================= */
function bindAddProductForm(){
  const box = document.getElementById("uploadBox");
  const file = document.getElementById("pImage");
  const prevWrap = document.getElementById("imgPreviewWrap");
  const prevImg = document.getElementById("imgPreview");
  const btnRemove = document.getElementById("btnRemoveImage");

  box?.addEventListener("click", ()=> file?.click());

  file?.addEventListener("change", async ()=>{
    if (!file.files || !file.files[0]) return;
    imageDataURL = await fileToDataURL(file.files[0]);
    if (prevImg) prevImg.src = imageDataURL;
    prevWrap?.classList.remove("hidden");
    box?.classList.add("hidden");
  });

  btnRemove?.addEventListener("click", ()=>{
    imageDataURL = null;
    prevWrap?.classList.add("hidden");
    box?.classList.remove("hidden");
    if (file) file.value = "";
  });

  document.getElementById("btnCancelAdd")?.addEventListener("click", ()=> navigate("inventory"));
  document.getElementById("btnSaveProduct")?.addEventListener("click", saveNewProduct);
}

function renderAddProductPage(){
  const cats = getCategories();
  const dd = document.getElementById("pCategory");
  if (dd){
    dd.innerHTML = cats.map(c=>
      `<option value="${escapeAttr(c.name)}">${escapeHtml(c.icon||"")} ${escapeHtml(c.name)}</option>`
    ).join("");
  }
  clearAddForm();
}

function clearAddForm(){
  setVal("pName","");
  setVal("pSub","");
  setVal("pBarcode","");
  setVal("pSize","");
  setVal("pDesc","");
  setVal("pPrice","");
  setVal("pStock","");
  setVal("pLow", String(LOW_STOCK_DEFAULT));
  setVal("pGst","");

  imageDataURL = null;
  document.getElementById("imgPreviewWrap")?.classList.add("hidden");
  document.getElementById("uploadBox")?.classList.remove("hidden");
  const file = document.getElementById("pImage");
  if (file) file.value = "";
}

function saveNewProduct(){
  const cats = getCategories();
  if (!cats.length){
    alert("No categories found. Go to Settings and add categories first.");
    return;
  }

  const name = getVal("pName").trim();
  const category = getVal("pCategory").trim();
  const sub = getVal("pSub").trim();
  const barcode = getVal("pBarcode").trim();
  const size = getVal("pSize").trim();
  const desc = getVal("pDesc").trim();
  const price = Number(getVal("pPrice"));
  const stock = Number(getVal("pStock"));
  const lowStock = Number(getVal("pLow") || LOW_STOCK_DEFAULT);

  const gstRate = Number(getVal("pGst"));
  if (!isFinite(gstRate) || gstRate < 0 || gstRate > 100){
    alert("Please enter GST Rate (0 to 100).");
    return;
  }

  if (!name || !category || !barcode || !isFinite(price) || !isFinite(stock)){
    alert("Please fill required fields: Name, Category, Barcode, Price, Stock.");
    return;
  }

  const prods = getProducts();
  const exists = prods.some(p => String(p.barcode) === String(barcode));
  if (exists){
    alert("Barcode already exists. If it is the SAME item, increase stock instead of creating duplicate.");
    return;
  }

  const id = makeId(name, barcode);

  const product = {
    id,
    name,
    category,
    sub: sub || "All",
    price: round2(price),
    size,
    stock: Math.max(0, Math.floor(stock)),
    barcode,
    barcodes: [barcode], // ✅ keep primary also inside aliases for safety
    desc,
    lowStock: Math.max(0, Math.floor(lowStock)),
    gstRate: round2(gstRate),
    image: imageDataURL || null,
    createdAt: new Date().toISOString()
  };

  prods.unshift(product);
  setProducts(prods);

  alert("Product saved ✅\nRefresh Cashier to see it.");
  clearAddForm();
  navigate("inventory");
}

/* =========================================================
   ORDERS
   ========================================================= */
function bindOrdersControls(){
  document.getElementById("btnExportOrders")?.addEventListener("click", exportOrdersCSV);

  document.getElementById("ordSearch")?.addEventListener("input", (e)=>{
    state.ordSearch = e.target.value.trim().toLowerCase();
    renderOrders();
  });

  document.getElementById("ordCashier")?.addEventListener("change", (e)=>{
    state.ordCashier = e.target.value;
    renderOrders();
  });

  document.getElementById("ordStatus")?.addEventListener("change", (e)=>{
    state.ordStatus = e.target.value;
    renderOrders();
  });

  document.getElementById("ordApply")?.addEventListener("click", ()=>{
    state.ordPreset = document.getElementById("ordPreset")?.value || "today";
    state.ordFrom = document.getElementById("ordFrom")?.value || "";
    state.ordTo   = document.getElementById("ordTo")?.value || "";
    renderOrders();
  });

  document.getElementById("ordPreset")?.addEventListener("change", ()=>{
    syncOrdersDateUI();
  });

  syncOrdersDateUI();
}

function syncOrdersDateUI(){
  const preset = document.getElementById("ordPreset")?.value || "today";
  const fromEl = document.getElementById("ordFrom");
  const toEl = document.getElementById("ordTo");
  if (!fromEl || !toEl) return;

  const isCustom = preset === "custom";
  fromEl.style.display = isCustom ? "inline-flex" : "none";
  toEl.style.display = isCustom ? "inline-flex" : "none";
}

function renderOrders(){
  forceAllTableHeaders();

  const ordersAll = getOrders();

  const todayKey = isoDateKey(new Date());
  const todays = ordersAll.filter(o => (o.ts||"").slice(0,10) === todayKey);

  const todayRevenue = todays.reduce((s,o)=> s + num(o.amount), 0);
  setText("ordTodayCount", String(todays.length));
  setText("ordTodayRevenue", money(todayRevenue));
  setText("ordRefunds", String(todays.filter(o => (o.status||"") === "REFUNDED").length));

  const cashiers = Array.from(new Set(ordersAll.map(o => o.cashier).filter(Boolean)));
  const dd = document.getElementById("ordCashier");
  if (dd){
    dd.innerHTML = `<option value="">Cashier: All</option>` +
      cashiers.map(c=>`<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
    if (state.ordCashier) dd.value = state.ordCashier;
  }

  let list;
  if (state.ordPreset !== "custom"){
    const r = getPresetRange(state.ordPreset);
    list = filterOrdersByDate(ordersAll, r.from, r.to);
  } else {
    list = filterOrdersByDate(
      ordersAll,
      state.ordFrom ? startOfDay(new Date(state.ordFrom)) : null,
      state.ordTo ? endOfDay(new Date(state.ordTo)) : null
    );
  }

  const q = ((state.ordSearch || state.globalSearch) || "").trim().toLowerCase();
  if (q){
    list = list.filter(o=>{
      const hay = `${o.receiptId} ${o.cashier} ${o.terminal} ${(o.items||[]).map(i=>i.name).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  if (state.ordCashier) list = list.filter(o => o.cashier === state.ordCashier);
  if (state.ordStatus) list = list.filter(o => (o.status||"COMPLETED") === state.ordStatus);

  const body = document.getElementById("ordersBody");
  if (!body) return;

  body.innerHTML = "";
  list.forEach(o=>{
    const itemsText = (o.items||[]).slice(0,2).map(i=>`${i.qty}x ${i.name}`).join(", ")
      + ((o.items||[]).length > 2 ? `, +${(o.items||[]).length-2} more` : "");

    const row = document.createElement("div");
    row.className = "trow ordHead";
    forceGrid(row, "1fr 1.1fr 1.7fr 0.8fr 0.8fr 0.8fr 0.7fr");

    row.innerHTML = `
      <div style="font-weight:1000;color:#1d4ed8">${escapeHtml(o.receiptId||"—")}</div>
      <div>
        <div>${escapeHtml(o.ts ? new Date(o.ts).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}) : "—")}</div>
        <div style="font-size:12px;color:rgba(17,24,39,.6)">${escapeHtml(o.timeLabel||fmtTime(o.ts))}</div>
      </div>
      <div style="opacity:.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(itemsText||"—")}</div>
      <div>${escapeHtml(o.cashier||"—")}</div>
      <div style="font-weight:1000">${money(num(o.amount))}</div>
      <div>${statusBadge(o.status||"COMPLETED")}</div>
      <div class="rowActions" style="display:flex; justify-content:flex-end; gap:10px;">
        <button class="iconBtn" title="View" type="button">👁</button>
      </div>
    `;

    row.querySelector(".iconBtn")?.addEventListener("click", ()=> alert(orderDetailsText(o)));
    body.appendChild(row);
  });

  setText("ordersFoot", `Showing ${list.length} of ${ordersAll.length}`);
}

/* =========================================================
   REPORTS (revenue uses order.amount only)
   ========================================================= */
function bindReportsControls(){
  document.getElementById("repExport")?.addEventListener("click", exportOrdersCSV);
  document.getElementById("repViewAll")?.addEventListener("click", ()=> navigate("orders"));

  document.getElementById("repApply")?.addEventListener("click", ()=>{
    state.repPreset = document.getElementById("repPreset")?.value || state.repPreset || "all";
    state.repFrom = document.getElementById("repFrom")?.value || "";
    state.repTo   = document.getElementById("repTo")?.value || "";
    renderReports();
  });

  document.getElementById("repPreset")?.addEventListener("change", ()=> syncReportsDateUI());
  syncReportsDateUI();
}

function syncReportsDateUI(){
  const preset = document.getElementById("repPreset")?.value || state.repPreset || "all";
  const fromEl = document.getElementById("repFrom");
  const toEl = document.getElementById("repTo");
  if (!fromEl || !toEl) return;

  const isCustom = preset === "custom";
  fromEl.style.display = isCustom ? "inline-flex" : "none";
  toEl.style.display = isCustom ? "inline-flex" : "none";
}

function renderReports(){
  forceAllTableHeaders();

  const uiPreset = document.getElementById("repPreset")?.value;
  if (uiPreset) state.repPreset = uiPreset;

  let orders;
  if (state.repPreset !== "custom"){
    const r = getPresetRange(state.repPreset);
    orders = filterOrdersByDate(getOrders(), r.from, r.to);
  } else {
    orders = filterOrdersByDate(
      getOrders(),
      state.repFrom ? startOfDay(new Date(state.repFrom)) : null,
      state.repTo ? endOfDay(new Date(state.repTo)) : null
    );
  }

  const grossSales = orders.reduce((sum, o) => sum + num(o.amount), 0);
  const totalOrders = orders.length;
  const aov = totalOrders ? grossSales / totalOrders : 0;

  setText("repTotalRevenue", money(grossSales));
  setText("repTotalOrders", String(totalOrders));
  setText("repAov", money(aov));

  renderTopProducts(orders);

  const catMap = new Map();
  orders.forEach(o=>{
    (o.items||[]).forEach(it=>{
      const cat = it.category || "—";
      const line = num(it.price) * num(it.qty);
      catMap.set(cat, (catMap.get(cat)||0) + line);
    });
  });
  drawDonut(catMap);
}

/* =========================================================
   SETTINGS
   ========================================================= */
function bindSettingsControls(){
  document.getElementById("btnAddCategory")?.addEventListener("click", ()=>{
    const name = getVal("catName").trim();
    const icon = getVal("catIcon").trim() || "•";
    if (!name){ alert("Enter category name"); return; }

    const cats = getCategories();
    const exists = cats.some(c => c.name.toLowerCase() === name.toLowerCase());
    if (exists){ alert("Category already exists"); return; }

    cats.push({ name, icon });
    setCategories(cats);
    setVal("catName","");
    setVal("catIcon","");
    renderSettings();
  });

  document.getElementById("btnResetAll")?.addEventListener("click", async ()=>{
    const ok = confirm("This will DELETE Products, Categories, Orders, Purchases.\n(Cloud + Local)\nAre you sure?");
    if (!ok) return;

    try{
      if (!FB.enabled){
        alert("Firebase is not enabled. Cannot reset cloud data.");
        return;
      }

      const [pSnap, cSnap, oSnap, purSnap] = await Promise.all([
        _prodsRef().get(),
        _catsRef().get(),
        _ordersRef().get(),
        _purchasesRef().get(),
      ]);

      const batch = FB.db.batch();
      pSnap.forEach(d=> batch.delete(d.ref));
      cSnap.forEach(d=> batch.delete(d.ref));
      oSnap.forEach(d=> batch.delete(d.ref));
      purSnap.forEach(d=> batch.delete(d.ref));
      await batch.commit();

      localStorage.removeItem(LS_PRODUCTS);
      localStorage.removeItem(LS_CATEGORIES);
      localStorage.removeItem(LS_ORDERS);
      localStorage.removeItem(LS_PURCHASES);
      seedIfMissing();

      alert("Reset done ✅ (Cloud cleared)");
      renderSettings();
      renderInventory();
      renderDashboard();
      renderOrders();
      renderReports();
      if (state.route === "purchases") renderPurchases();

    } catch(e){
      console.error("RESET FAILED:", e);
      alert("Reset failed. Open console (F12) and share the error.");
    }
  });
}

function renderSettings(){
  const cats = getCategories();
  const list = document.getElementById("catList");
  if (!list) return;

  list.innerHTML = "";
  cats.forEach(c=>{
    const div = document.createElement("div");
    div.className = "miniItem";
    div.innerHTML = `
      <div class="l">
        <div class="t">${escapeHtml(c.icon||"")} ${escapeHtml(c.name)}</div>
        <div class="s">Used on cashier sidebar</div>
      </div>
      <button class="btn ghost danger" data-del="${escapeAttr(c.name)}">Delete</button>
    `;
    div.querySelector("[data-del]")?.addEventListener("click", ()=>{
      const ok = confirm(`Delete category "${c.name}"? Products will still keep category text.`);
      if (!ok) return;
      const next = getCategories().filter(x => x.name !== c.name);
      setCategories(next);
      renderSettings();
    });
    list.appendChild(div);
  });
}

/* =========================================================
   MODAL (Edit / Restock)
   ========================================================= */
function bindModalControls(){
  const modalOverlay = document.getElementById("modalOverlay");
  const modalClose = document.getElementById("modalClose");
  const modalSave = document.getElementById("modalSave");
  const modalDelete = document.getElementById("modalDelete");

  modalClose?.addEventListener("click", closeModal);
  modalOverlay?.addEventListener("click", (e)=>{
    if (e.target === modalOverlay) closeModal();
  });

  modalSave?.addEventListener("click", onModalSave);
  modalDelete?.addEventListener("click", onModalDelete);
}

function openEditProductModal(productId){
  const modalOverlay = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");
  if (!modalOverlay || !modalBody) return;

  const prods = getProducts();
  const p = prods.find(x=>x.id===productId);
  if (!p) return;

  state.editProductId = productId;

  setText("modalTitle", "Edit Product");
  setText("modalSub", "Update product details");

  const cats = getCategories();

  modalBody.innerHTML = `
    <div class="form" style="padding:0;">
      <div class="field">
        <label>Name</label>
        <input id="mName" value="${escapeAttr(p.name||"")}" />
      </div>

      <div class="fieldRow">
        <div class="field">
          <label>Category</label>
          <select id="mCategory" class="select">
            ${cats.map(c=>`<option value="${escapeAttr(c.name)}">${escapeHtml(c.icon||"")} ${escapeHtml(c.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Subcategory</label>
          <input id="mSub" value="${escapeAttr(p.sub||"")}" />
        </div>
        <div class="field">
          <label>Barcode (primary)</label>
          <input id="mBarcode" value="${escapeAttr(p.barcode||"")}" />
        </div>
      </div>

      <div class="fieldRow">
        <div class="field">
          <label>Price (₹)</label>
          <input id="mPrice" type="number" step="0.01" value="${escapeAttr(num(p.price))}" />
        </div>
        <div class="field">
          <label>GST Rate (%)</label>
          <input id="mGst" type="number" min="0" max="100" step="0.01" value="${escapeAttr(isFinite(Number(p.gstRate)) ? Number(p.gstRate) : "")}" placeholder="e.g. 18" />
        </div>
        <div class="field">
          <label>Stock</label>
          <input id="mStock" type="number" step="1" value="${escapeAttr(num(p.stock))}" />
        </div>
      </div>

      <div class="fieldRow">
        <div class="field">
          <label>Low Stock Threshold</label>
          <input id="mLow" type="number" step="1" value="${escapeAttr(num(p.lowStock||LOW_STOCK_DEFAULT))}" />
        </div>
        <div class="field">
          <label>Size / Variant</label>
          <input id="mSize" value="${escapeAttr(p.size||"")}" />
        </div>
      </div>

      <div class="field">
        <label>Description</label>
        <textarea id="mDesc" rows="3">${escapeHtml(p.desc||"")}</textarea>
      </div>

      <div class="note" style="margin-top:10px;">
        Tip: You can have multiple barcodes for same product (aliases) automatically via Purchases linking.
      </div>
    </div>
  `;

  const mCat = document.getElementById("mCategory");
  if (mCat) mCat.value = p.category || (cats[0]?.name || "");

  openModal();
}

function openRestockModal(productId){
  const modalOverlay = document.getElementById("modalOverlay");
  const modalBody = document.getElementById("modalBody");
  if (!modalOverlay || !modalBody) return;

  const prods = getProducts();
  const p = prods.find(x=>x.id===productId);
  if (!p) return;

  state.editProductId = productId;

  setText("modalTitle", "Restock Product");
  setText("modalSub", p.name);

  modalBody.innerHTML = `
    <div class="form" style="padding:0;">
      <div class="fieldRow" style="grid-template-columns: 1fr 1fr;">
        <div class="field">
          <label>Current Stock</label>
          <input value="${escapeAttr(Math.floor(num(p.stock)))}" disabled />
        </div>
        <div class="field">
          <label>Add Stock</label>
          <input id="mAddStock" type="number" min="0" step="1" placeholder="e.g. 20" />
        </div>
      </div>
      <div class="note">This will increase stock and save instantly when you click Save Changes.</div>
    </div>
  `;

  openModal();
}

function openModal(){
  const modalOverlay = document.getElementById("modalOverlay");
  if (!modalOverlay) return;
  modalOverlay.classList.remove("hidden");
  modalOverlay.setAttribute("aria-hidden","false");
}

function closeModal(){
  const modalOverlay = document.getElementById("modalOverlay");
  if (!modalOverlay) return;
  modalOverlay.classList.add("hidden");
  modalOverlay.setAttribute("aria-hidden","true");
  state.editProductId = null;
}

async function onModalSave(){
  if (!state.editProductId) return;

  const prods = getProducts();
  const idx = prods.findIndex(x=>x.id===state.editProductId);
  if (idx < 0) return;

  const addStockEl = document.getElementById("mAddStock");
  if (addStockEl){
    const add = Number(addStockEl.value || 0);
    prods[idx].stock = Math.max(0, num(prods[idx].stock) + Math.floor(num(add)));
    setProducts(prods);
    closeModal();
    renderInventory();
    renderDashboard();
    return;
  }

  const name = getVal("mName").trim();
  const category = getVal("mCategory").trim();
  const sub = getVal("mSub").trim();
  const barcode = getVal("mBarcode").trim();
  const price = Number(getVal("mPrice"));
  const gstRate = Number(getVal("mGst"));
  const stock = Number(getVal("mStock"));
  const lowStock = Number(getVal("mLow") || LOW_STOCK_DEFAULT);
  const size = getVal("mSize").trim();
  const desc = getVal("mDesc").trim();

  if (!name || !category || !barcode || !isFinite(price) || !isFinite(stock)){
    alert("Name, Category, Barcode, Price, Stock are required.");
    return;
  }
  if (!isFinite(gstRate) || gstRate < 0 || gstRate > 100){
    alert("Please enter GST Rate (0 to 100).");
    return;
  }

  const exists = prods.some((p,i)=> i!==idx && String(p.barcode)===String(barcode));
  if (exists){
    alert("Barcode already used by another product.");
    return;
  }

  // ensure barcodes array keeps primary too
  const set = new Set(Array.isArray(prods[idx].barcodes) ? prods[idx].barcodes.map(x=>String(x).trim()).filter(Boolean) : []);
  if (barcode) set.add(barcode);

  prods[idx] = {
    ...prods[idx],
    name,
    category,
    sub: sub || prods[idx].sub || "All",
    barcode,
    barcodes: Array.from(set),
    price: round2(price),
    gstRate: round2(gstRate),
    stock: Math.max(0, Math.floor(stock)),
    lowStock: Math.max(0, Math.floor(lowStock)),
    size,
    desc,
    updatedAt: new Date().toISOString()
  };

  setProducts(prods);
  closeModal();
  renderInventory();
  renderDashboard();
  if (state.route === "reports") renderReports();
}

async function onModalDelete(){
  if (!state.editProductId) return;
  const ok = confirm("Delete this product?");
  if (!ok) return;

  const prods = getProducts().filter(p=>p.id!==state.editProductId);
  setProducts(prods);

  closeModal();
  renderInventory();
  renderDashboard();
}

/* =========================================================
   TOP PRODUCTS + DONUT (Reports)
   ========================================================= */
function renderTopProducts(orders){
  const map = new Map();

  orders.forEach(o=>{
    (o.items||[]).forEach(it=>{
      const key = it.name || "—";
      const curr = map.get(key) || { revenue:0, units:0, category: it.category || "—" };
      curr.revenue += (num(it.price) * num(it.qty));
      curr.units += num(it.qty);
      if (!curr.category || curr.category==="—") curr.category = it.category || "—";
      map.set(key, curr);
    });
  });

  const list = Array.from(map.entries())
    .map(([name, v])=> ({ name, ...v }))
    .sort((a,b)=> b.revenue - a.revenue)
    .slice(0,10);

  const body = document.getElementById("topProductsBody");
  if (!body) return;

  body.innerHTML = "";
  if (!list.length){
    body.innerHTML = `<div style="padding:14px;color:rgba(17,24,39,.6)">No orders found in this date range.</div>`;
    return;
  }

  list.forEach((p, idx)=>{
    const row = document.createElement("div");
    row.className = "trow topHead";
    forceGrid(row, "0.6fr 1.6fr 1fr 0.7fr 0.9fr");

    row.innerHTML = `
      <div style="font-weight:1000">#${idx+1}</div>
      <div style="font-weight:950">${escapeHtml(p.name)}</div>
      <div><span class="badge">${escapeHtml(p.category||"—")}</span></div>
      <div>${Math.floor(num(p.units||0))}</div>
      <div style="font-weight:1000">${money(num(p.revenue||0))}</div>
    `;
    body.appendChild(row);
  });
}

function drawDonut(catMap){
  const canvas = document.getElementById("donutCanvas");
  const legend = document.getElementById("donutLegend");
  if (!canvas || !legend) return;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const entries = Array.from(catMap.entries()).sort((a,b)=> b[1]-a[1]);
  const total = entries.reduce((s, [,v])=> s+v, 0) || 1;

  const colors = [
    "rgba(37,99,235,.85)",
    "rgba(22,163,74,.85)",
    "rgba(245,158,11,.85)",
    "rgba(239,68,68,.75)",
    "rgba(17,24,39,.35)"
  ];

  const cx = canvas.width/2, cy = canvas.height/2;
  const rOuter = 130, rInner = 80;

  let start = -Math.PI/2;
  entries.forEach(([cat, val], idx)=>{
    const frac = val/total;
    const end = start + frac*2*Math.PI;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rOuter, start, end);
    ctx.closePath();
    ctx.fillStyle = colors[idx % colors.length];
    ctx.fill();

    start = end;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, 2*Math.PI);
  ctx.fillStyle = "#fff";
  ctx.fill();

  ctx.fillStyle = "rgba(17,24,39,.85)";
  ctx.font = "700 16px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  ctx.fillText("Total", cx, cy-8);
  ctx.font = "900 18px ui-sans-serif, system-ui";
  ctx.fillText(moneyShort(total), cx, cy+18);

  legend.innerHTML = "";
  if (!entries.length){
    legend.innerHTML = `<div class="smallMuted">No category data yet.</div>`;
    return;
  }

  entries.slice(0,6).forEach(([cat, val], idx)=>{
    const pct = Math.round((val/total)*100);
    const item = document.createElement("div");
    item.style.display = "flex";
    item.style.justifyContent = "space-between";
    item.style.gap = "12px";
    item.style.fontSize = "13px";
    item.style.padding = "6px 0";
    item.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center;">
        <span style="width:10px;height:10px;border-radius:999px;background:${colors[idx%colors.length]};display:inline-block;"></span>
        <span>${escapeHtml(cat)}</span>
      </div>
      <div style="color:rgba(17,24,39,.65)">${pct}%</div>
    `;
    legend.appendChild(item);
  });
}

/* =========================================================
   EXPORT
   ========================================================= */
function exportOrdersCSV(){
  const orders = getOrders();
  if (!orders.length){
    alert("No orders to export yet.");
    return;
  }

  const flat = [];
  orders.forEach(o=>{
    (o.items||[]).forEach(it=>{
      flat.push({
        receiptId: o.receiptId || "",
        ts: o.ts || "",
        time: o.timeLabel || "",
        cashier: o.cashier || "",
        terminal: o.terminal || "",
        method: o.method || "",
        status: o.status || "",
        itemName: it.name || "",
        category: it.category || "",
        qty: num(it.qty),
        unitPrice: num(it.price),
        gstRate: isFinite(Number(it.gstRate)) ? Number(it.gstRate) : "",
        lineTotal: round2(num(it.price) * num(it.qty)),
        orderSubtotal: round2(orderSubtotal(o)),
        orderTax: round2(orderTax(o)),
        orderTotal: num(o.amount)
      });
    });
  });

  const csv = toCSV(flat);
  downloadText(csv, `madira_orders_${isoDateKey(new Date())}.csv`, "text/csv");
}

/* =========================================================
   AUTH IDENTITY
   ========================================================= */
function hydrateAdminIdentity(){
  let sess = null;

  try {
    if (typeof window.getSession === "function") {
      sess = window.getSession();
    }
  } catch {}

  if (!sess) {
    sess = safeJSON(localStorage.getItem("bs_auth_session"), null)
        || safeJSON(localStorage.getItem(LS_AUTH), null);
  }

  if (sess?.name){
    setText("adminName", sess.name);
    setText("avatar", initials(sess.name));
  } else {
    setText("adminName", "Admin");
    setText("avatar", "A");
  }
}

/* =========================================================
   HELPERS
   ========================================================= */
function safeJSON(str, fallback){
  try { return JSON.parse(str); } catch { return fallback; }
}

function setText(id, val){
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function getVal(id){
  return document.getElementById(id)?.value ?? "";
}
function setVal(id, v){
  const el = document.getElementById(id);
  if (el) el.value = v;
}

function escapeHtml(str){
  return String(str||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escapeAttr(str){
  return escapeHtml(str).replaceAll("\n"," ");
}

function money(n){
  const v = Number(n || 0);
  return v.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  });
}
function moneyShort(n){
  const v = Number(n||0);
  if (v >= 10000000) return `₹${(v/10000000).toFixed(1)}Cr`;
  if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000) return `₹${(v/1000).toFixed(1)}k`;
  return money(v);
}
function round2(n){
  return Math.round((Number(n)||0) * 100) / 100;
}
function isoDateKey(d){
  const x = new Date(d);
  return x.toISOString().slice(0,10);
}
function fmtTime(ts){
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}
function stockStatus(p){
  const stock = num(p.stock);
  const low = num(p.lowStock||LOW_STOCK_DEFAULT);
  if (stock <= 0) return "Out of Stock";
  if (stock <= low) return "Low Stock";
  return "In Stock";
}
function statusBadge(s){
  const st = String(s||"COMPLETED").toUpperCase();
  if (st === "COMPLETED") return `<span class="badge green">Completed</span>`;
  if (st === "REFUNDED") return `<span class="badge red">Refunded</span>`;
  return `<span class="badge">${escapeHtml(st)}</span>`;
}
function orderDetailsText(o){
  const lines = (o.items||[]).map(i=>`${i.qty}x ${i.name}  ${money(num(i.price)*num(i.qty))}`).join("\n");
  return `Madira Beer Shop
${o.receiptId || "#—"}
${o.ts ? new Date(o.ts).toLocaleString("en-IN") : ""}

${lines}

Subtotal: ${money(orderSubtotal(o))}
Tax:      ${money(orderTax(o))}
Total:    ${money(num(o.amount))}
Payment:  ${o.method||""}
Status:   ${o.status||""}
Cashier:  ${o.cashier||""}
Terminal: ${o.terminal||""}`;
}
function makeId(name, barcode){
  const base = String(name||"product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,"_")
    .replace(/^_+|_+$/g,"")
    .slice(0,24);
  return `${base}_${String(barcode).slice(-6)}`.toLowerCase();
}
function initials(name){
  return String(name||"")
    .split(" ")
    .filter(Boolean)
    .slice(0,2)
    .map(x=>x[0].toUpperCase())
    .join("") || "A";
}

async function fileToDataURL(file){
  return new Promise((res, rej)=>{
    const r = new FileReader();
    r.onload = ()=> res(String(r.result));
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
function toCSV(rows){
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v)=> `"${String(v??"").replaceAll('"','""')}"`;
  const head = cols.map(esc).join(",");
  const body = rows.map(r => cols.map(c=>esc(r[c])).join(",")).join("\n");
  return head + "\n" + body;
}
function downloadText(text, filename, mime){
  const blob = new Blob([text], {type:mime || "text/plain"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =========================================================
   DATE FILTER UTILS
   ========================================================= */
function startOfDay(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
}
function endOfDay(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23,59,59,999);
}
function getPresetRange(preset){
  const now = new Date();
  if (preset === "all") return {from:null, to:null};

  if (preset === "today"){
    return { from:startOfDay(now), to:endOfDay(now) };
  }
  if (preset === "week"){
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day + 1);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { from:startOfDay(monday), to:endOfDay(sunday) };
  }
  if (preset === "month"){
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last  = new Date(now.getFullYear(), now.getMonth()+1, 0);
    return { from:startOfDay(first), to:endOfDay(last) };
  }
  if (preset === "year"){
    return {
      from:startOfDay(new Date(now.getFullYear(),0,1)),
      to:endOfDay(new Date(now.getFullYear(),11,31))
    };
  }
  return {from:null, to:null};
}
function filterOrdersByDate(orders, from, to){
  if (!from && !to) return orders;
  return orders.filter(o=>{
    const ts = o.ts ? new Date(o.ts) : null;
    if (!ts) return false;
    if (from && ts < from) return false;
    if (to && ts > to) return false;
    return true;
  });
}

/* =========================================================
   ✅ STOCK PURCHASES (INWARD) — WITH BARCODE SCAN + LINKING
   ========================================================= */

let purchaseDraft = []; // { productId, name, qty, cost, lineTotal }

function bindPurchasesControls(){
  document.getElementById("purPreset")?.addEventListener("change", () => syncPurchasesDateUI());

  document.getElementById("purApply")?.addEventListener("click", () => {
    state.purPreset = document.getElementById("purPreset")?.value || "all";
    state.purFrom   = document.getElementById("purFrom")?.value || "";
    state.purTo     = document.getElementById("purTo")?.value || "";
    renderPurchases();
  });

  document.getElementById("purSearch")?.addEventListener("input", (e) => {
    state.purSearch = (e.target.value || "").trim().toLowerCase();
    renderPurchases();
  });

  // ✅ Scan input (optional)
  const scanInp = document.getElementById("purBarcodeScan");
  if (scanInp){
    scanInp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const code = String(scanInp.value || "").trim();
      scanInp.value = "";
      if (!code) return;
      handlePurchaseBarcode(code);
    });
  }

  // ✅ Wedge scanner: works without focusing input
  bindPurchaseWedgeScanner();

  document.getElementById("purAddItem")?.addEventListener("click", () => {
    const prods = getProducts();
    const sel = document.getElementById("purProductSelect");
    const pid = sel?.value || "";
    const p = prods.find(x => x.id === pid);
    if (!p) { alert("Select a product"); return; }

    const qty = Math.floor(num(document.getElementById("purQty")?.value || 0));
    const cost = round2(num(document.getElementById("purCost")?.value || 0));

    if (qty <= 0) { alert("Enter qty"); return; }
    if (cost < 0) { alert("Enter valid cost"); return; }

    purchaseDraft.push({
      productId: p.id,
      name: p.name,
      qty,
      cost,
      lineTotal: round2(qty * cost)
    });

    if (document.getElementById("purQty")) document.getElementById("purQty").value = "";
    if (document.getElementById("purCost")) document.getElementById("purCost").value = "";

    renderPurchaseDraft();
  });

  document.getElementById("purClearDraft")?.addEventListener("click", () => {
    purchaseDraft = [];
    renderPurchaseDraft();
  });

  document.getElementById("purSave")?.addEventListener("click", savePurchaseEntry);
}

function syncPurchasesDateUI(){
  const preset = document.getElementById("purPreset")?.value || state.purPreset || "all";
  const fromEl = document.getElementById("purFrom");
  const toEl = document.getElementById("purTo");
  if (!fromEl || !toEl) return;

  const isCustom = preset === "custom";
  fromEl.style.display = isCustom ? "inline-flex" : "none";
  toEl.style.display = isCustom ? "inline-flex" : "none";
}

function renderPurchaseProductSelect(){
  const sel = document.getElementById("purProductSelect");
  if (!sel) return;

  const prods = getProducts();
  sel.innerHTML = prods.length
    ? prods.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.category||"")})</option>`).join("")
    : `<option value="">No products</option>`;
}

function renderPurchaseDraft(){
  forceAllTableHeaders();
  renderPurchaseProductSelect();

  const body = document.getElementById("purDraftBody");
  const totalEl = document.getElementById("purDraftTotal");
  if (!body) return;

  body.innerHTML = "";

  if (!purchaseDraft.length){
    if (totalEl) totalEl.textContent = "Total: ₹0.00";
    return;
  }

  const total = purchaseDraft.reduce((s, x) => s + num(x.lineTotal), 0);
  if (totalEl) totalEl.textContent = `Total: ${money(total)}`;

  purchaseDraft.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "trow";
    forceGrid(row, "1.6fr 0.6fr 0.7fr 0.8fr 0.5fr");

    row.innerHTML = `
      <div style="font-weight:950">${escapeHtml(it.name)}</div>
      <div>${Math.floor(num(it.qty))}</div>
      <div>${money(num(it.cost))}</div>
      <div style="font-weight:1000">${money(num(it.lineTotal))}</div>
      <div style="display:flex; justify-content:flex-end;">
        <button class="iconBtn" title="Remove" type="button">🗑</button>
      </div>
    `;

    row.querySelector(".iconBtn")?.addEventListener("click", () => {
      purchaseDraft.splice(idx, 1);
      renderPurchaseDraft();
    });

    body.appendChild(row);
  });
}

/* ----------------------------
   Barcode find + link logic
----------------------------- */
function normalizeCode(code){
  return String(code || "").trim();
}

function findProductByBarcode(code){
  const c = normalizeCode(code);
  if (!c) return null;

  const prods = getProducts();
  return prods.find(p => {
    const primary = normalizeCode(p.barcode);
    if (primary && primary === c) return true;

    const arr = Array.isArray(p.barcodes) ? p.barcodes.map(normalizeCode) : [];
    return arr.includes(c);
  }) || null;
}

function linkBarcodeToProduct(productId, code, makePrimary=false){
  const c = normalizeCode(code);
  if (!c) return;

  const prods = getProducts();
  const p = prods.find(x => x.id === productId);
  if (!p) return;

  const set = new Set();

  const primary = normalizeCode(p.barcode);
  if (primary) set.add(primary);

  if (Array.isArray(p.barcodes)){
    p.barcodes.forEach(b => {
      const bb = normalizeCode(b);
      if (bb) set.add(bb);
    });
  }

  set.add(c);
  p.barcodes = Array.from(set);

  if (makePrimary) p.barcode = c;

  setProducts(prods);
}

function handlePurchaseBarcode(code){
  const c = normalizeCode(code);
  if (!c) return;

  const found = findProductByBarcode(c);
  if (found){
    const sel = document.getElementById("purProductSelect");
    if (sel){
      sel.value = found.id;
      sel.dispatchEvent(new Event("change"));
    }

    const qtyEl = document.getElementById("purQty");
    if (qtyEl && !String(qtyEl.value || "").trim()) qtyEl.value = "1";

    const costEl = document.getElementById("purCost");
    (costEl || qtyEl)?.focus();
    return;
  }

  showLinkBarcodeDialog(c);
}

/* ----------------------------
   Wedge scanner (no focus)
----------------------------- */
function bindPurchaseWedgeScanner(){
  if (window.__PURCHASE_WEDGE_BOUND__) return;
  window.__PURCHASE_WEDGE_BOUND__ = true;

  let buf = "";
  let timer = null;
  const TIMEOUT_MS = 60;
  const MIN_LEN = 4;

  window.addEventListener("keydown", (e) => {
    if (state.route !== "purchases") return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const ae = document.activeElement;
    const isTypingOtherInput =
      ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") &&
      ae.id !== "purBarcodeScan";
    if (isTypingOtherInput) return;

    const k = e.key;

    if (k === "Enter") {
      if (buf.length >= MIN_LEN) {
        const code = buf;
        buf = "";
        if (timer) clearTimeout(timer);
        timer = null;

        handlePurchaseBarcode(code);

        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (k.length === 1) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { buf = ""; }, TIMEOUT_MS);

      if (/^[0-9A-Za-z]$/.test(k)) buf += k;
    }
  }, true);
}

/* ----------------------------
   Link dialog (separate overlay)
----------------------------- */
function showLinkBarcodeDialog(code){
  const c = normalizeCode(code);
  if (!c) return;

  const prods = getProducts();
  if (!prods.length){
    alert("No products available. Add products first, then link barcode.");
    return;
  }

  document.getElementById("lbOverlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "modalOverlay";
  overlay.id = "lbOverlay";
  overlay.setAttribute("aria-hidden","false");

  overlay.innerHTML = `
    <div class="modal">
      <div class="modalHead">
        <div>
          <div class="modalTitle">Link New Barcode</div>
          <div class="modalSub">Barcode <b>${escapeHtml(c)}</b> not found. Link it to an existing product so stock adds to previous stock.</div>
        </div>
        <button class="iconBtn" id="lbClose" type="button">✕</button>
      </div>

      <div class="modalBody">
        <div class="form" style="padding:0;">
          <div class="field">
            <label>Select Product to Link</label>
            <select id="lbProduct" class="select">
              ${prods.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.category||"")})</option>`).join("")}
            </select>
          </div>

          <div class="field" style="margin-top:10px;">
            <label style="display:block; margin:0; font-weight:700; color:rgba(17,24,39,.75);">
              <input id="lbPrimary" type="checkbox" />
              &nbsp;Set this barcode as PRIMARY (replace old primary barcode)
            </label>
            <div class="note" style="margin-top:8px;">Keep OFF normally. Turn ON only if you want cashier to treat this as main barcode.</div>
          </div>
        </div>
      </div>

      <div class="modalFoot">
        <button class="btn ghost" id="lbCancel" type="button">Cancel</button>
        <button class="btn" id="lbLink" type="button">Link Barcode</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector("#lbClose")?.addEventListener("click", close);
  overlay.querySelector("#lbCancel")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  overlay.querySelector("#lbLink")?.addEventListener("click", () => {
    const pid = overlay.querySelector("#lbProduct")?.value || "";
    const makePrimary = !!overlay.querySelector("#lbPrimary")?.checked;

    if (!pid) { alert("Select product"); return; }

    linkBarcodeToProduct(pid, c, makePrimary);
    close();

    const sel = document.getElementById("purProductSelect");
    if (sel) sel.value = pid;

    const qtyEl = document.getElementById("purQty");
    if (qtyEl && !String(qtyEl.value || "").trim()) qtyEl.value = "1";
    document.getElementById("purCost")?.focus();
  });
}

/* ----------------------------
   Save purchase + render history
----------------------------- */
async function savePurchaseEntry(){
  const supplier = (document.getElementById("purSupplier")?.value || "").trim();
  if (!supplier) { alert("Enter Dealer / Brand name"); return; }
  if (!purchaseDraft.length) { alert("Add at least 1 item"); return; }

  const invoice = (document.getElementById("purInvoice")?.value || "").trim();
  const method  = (document.getElementById("purMethod")?.value || "CASH").trim().toUpperCase();
  const note    = (document.getElementById("purNote")?.value || "").trim();
  const addToStock = !!document.getElementById("purAddToStock")?.checked;

  const totalPaid = round2(purchaseDraft.reduce((s, x) => s + num(x.lineTotal), 0));
  const now = new Date();
  const tsISO = now.toISOString();

  const purchase = {
    supplier,
    invoice,
    method,
    note,
    items: purchaseDraft.map(x => ({
      productId: x.productId,
      name: x.name,
      qty: Math.floor(num(x.qty)),
      cost: round2(num(x.cost)),
      lineTotal: round2(num(x.lineTotal))
    })),
    totalPaid,
    addToStock,
    tsISO,
    ts: tsISO
  };

  if (addToStock){
    const prods = getProducts();
    purchase.items.forEach(it => {
      const p = prods.find(x => x.id === it.productId);
      if (p){
        p.stock = Math.max(0, Math.floor(num(p.stock) + num(it.qty)));
      }
    });
    setProducts(prods);
  }

  try{
    if (FB.enabled){
      const docRef = _purchasesRef().doc();
      await docRef.set({
        supplier,
        invoice,
        method,
        note,
        items: purchase.items,
        totalPaid,
        addToStock,
        tsISO,
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge:true });
    } else {
      const list = getPurchases();
      list.unshift({ ...purchase, __docId: `local_${Date.now()}` });
      setPurchases(list);
    }
  } catch(e){
    console.error("Purchase save failed:", e);
    alert("Purchase save failed. Open console (F12) and share error.");
    return;
  }

  purchaseDraft = [];
  if (document.getElementById("purSupplier")) document.getElementById("purSupplier").value = "";
  if (document.getElementById("purInvoice")) document.getElementById("purInvoice").value = "";
  if (document.getElementById("purNote")) document.getElementById("purNote").value = "";

  renderPurchaseDraft();
  renderPurchases();
  alert("Purchase saved ✅");
}

function getPurchasesFiltered(){
  let list = getPurchases();

  let from = null, to = null;
  const preset = document.getElementById("purPreset")?.value || state.purPreset || "all";

  if (preset !== "custom"){
    const r = getPresetRange(preset);
    from = r.from; to = r.to;
  } else {
    from = state.purFrom ? startOfDay(new Date(state.purFrom)) : null;
    to   = state.purTo ? endOfDay(new Date(state.purTo)) : null;
  }

  if (from || to){
    list = list.filter(p => {
      const ts = p.ts ? new Date(p.ts) : (p.tsISO ? new Date(p.tsISO) : null);
      if (!ts || isNaN(ts.getTime())) return false;
      if (from && ts < from) return false;
      if (to && ts > to) return false;
      return true;
    });
  }

  const q = (state.purSearch || "").trim().toLowerCase();
  if (q){
    list = list.filter(p => {
      const hay = `${p.supplier||""} ${p.invoice||""} ${(p.items||[]).map(i=>i.name).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  return list;
}

function renderPurchases(){
  forceAllTableHeaders();

  syncPurchasesDateUI();
  renderPurchaseDraft();
  renderPurchaseProductSelect();

  const list = getPurchasesFiltered();

  const totalPaid = list.reduce((s, p) => s + num(p.totalPaid), 0);
  const count = list.length;
  const avg = count ? totalPaid / count : 0;

  setText("purTotalPaid", money(totalPaid));
  setText("purCount", String(count));
  setText("purAvg", money(avg));

  const body = document.getElementById("purTableBody");
  if (!body) return;

  body.innerHTML = "";

  list.forEach(p => {
    const itemsCount = (p.items || []).reduce((s,i)=> s + Math.floor(num(i.qty)), 0);
    const dateStr = p.ts ? new Date(p.ts).toLocaleString("en-IN") :
                    (p.tsISO ? new Date(p.tsISO).toLocaleString("en-IN") : "—");

    const row = document.createElement("div");
    row.className = "trow";
    forceGrid(row, "0.9fr 1.4fr 0.9fr 0.7fr 0.8fr 0.7fr 0.6fr");

    row.innerHTML = `
      <div>${escapeHtml(dateStr)}</div>
      <div style="font-weight:1000">${escapeHtml(p.supplier||"—")}</div>
      <div>${escapeHtml(p.invoice||"—")}</div>
      <div>${itemsCount} units</div>
      <div style="font-weight:1000">${money(num(p.totalPaid))}</div>
      <div><span class="badge">${escapeHtml(p.method||"—")}</span></div>
      <div style="display:flex; justify-content:flex-end; gap:10px;">
        <button class="iconBtn" title="View" type="button">👁</button>
        <button class="iconBtn" title="Delete" type="button">🗑</button>
      </div>
    `;

    const btns = row.querySelectorAll(".iconBtn");
    const btnView = btns[0];
    const btnDel = btns[1];

    btnView?.addEventListener("click", () => {
      const lines = (p.items||[]).map(i => `${i.qty}x ${i.name} @ ${money(i.cost)} = ${money(i.lineTotal)}`).join("\n");
      alert(`STOCK PURCHASE
Dealer/Brand: ${p.supplier||""}
Invoice: ${p.invoice||"—"}
Method: ${p.method||""}
Date: ${dateStr}

${lines}

TOTAL PAID: ${money(num(p.totalPaid))}
Note: ${p.note||"—"}
Add to Stock: ${p.addToStock ? "YES" : "NO"}`);
    });

    btnDel?.addEventListener("click", async () => {
      const ok = confirm(`Delete this purchase entry?\n${p.supplier||""} • ${money(num(p.totalPaid))}`);
      if (!ok) return;

      try{
        if (FB.enabled && p.__docId){
          await _purchasesRef().doc(p.__docId).delete();
        } else {
          const next = getPurchases().filter(x => x.__docId !== p.__docId);
          setPurchases(next);
          renderPurchases();
        }
      } catch(e){
        console.error("Purchase delete failed:", e);
        alert("Delete failed. Check console (F12).");
      }
    });

    body.appendChild(row);
  });

  setText("purFoot", `Showing ${list.length} of ${getPurchases().length}`);
}