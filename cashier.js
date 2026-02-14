/* =========================================================
   cashier.js (FULL UPDATED + FIREBASE)
   - Light theme compatible
   - Dynamic categories/products from Admin (Firestore -> LocalStorage cache)
   - Sales tab hides sidebar
   - Currency INR (₹)
   - USB barcode scanner auto-add (keyboard wedge + Enter)
   - Logout clears session + redirects
   - Product image uploaded in Admin shows in Cashier
   ========================================================= */

const TAX_RATE = 0.08;

const LS_ORDERS   = "madira_orders_v1";
const LS_SESSION  = "madira_cashier_session_v1";

// Admin data stores (shared)
const LS_PRODUCTS   = "madira_products_v1";
const LS_CATEGORIES = "madira_categories_v1";

// Optional auth keys to clear on logout
const LS_ADMIN_AUTH = "madira_auth_v1";
const LS_AUTH_BS    = "bs_auth_session";

const SHOP_NAME = "Madira Beer Shop";


// Call this after DOM loads
function hydrateCashierNameUI() {
  const nameEl = document.getElementById("cashierName");
  if (nameEl) nameEl.textContent = getCashierName();
}




/* ---------------------- FIREBASE CONFIG ---------------------- */
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
  unsub: { cats:null, prods:null, orders:null }
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
function _metaRef(){ return _shopRef().collection("meta").doc("counters"); }

async function fbInit(){
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
    console.warn("Firebase disabled (fallback to LocalStorage):", e);
    FB.enabled = false;
    return false;
  }
}

async function fbBootstrapIfEmpty(){
  const catsSnap = await _catsRef().limit(1).get();
  const prodsSnap = await _prodsRef().limit(1).get();

  if (!catsSnap.empty && !prodsSnap.empty) return;

  // Minimal seeds so cashier runs even if Admin never opened yet
  const seedCats = safeJSON(localStorage.getItem(LS_CATEGORIES), null) || SEED_CATEGORIES;
  const seedProds = safeJSON(localStorage.getItem(LS_PRODUCTS), null) || SEED_PRODUCTS;

  const batch = FB.db.batch();

  if (catsSnap.empty){
    seedCats.forEach(c=>{
      const id = String(c.name||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,50) || "cat";
      batch.set(_catsRef().doc(id), { name:c.name, icon:c.icon||"•", updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    });
  }

  if (prodsSnap.empty){
    seedProds.forEach(p=>{
      if (!p?.id) return;
      batch.set(_prodsRef().doc(p.id), { ...p, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    });
  }

  await batch.commit();
}

function fbStartRealtimeSync(){
  try{ FB.unsub.cats?.(); } catch {}
  try{ FB.unsub.prods?.(); } catch {}
  try{ FB.unsub.orders?.(); } catch {}

  // Categories -> LocalStorage cache
  FB.unsub.cats = _catsRef().onSnapshot((snap)=>{
    const cats = snap.docs.map(d=>d.data()).filter(Boolean);
    localStorage.setItem(LS_CATEGORIES, JSON.stringify(cats));
    loadAdminData();
    const exists = CATEGORIES.some(c => c.name === activeCategory);
    if (!exists){
      activeCategory = CATEGORIES[0]?.name || "Beers";
      activeSub = defaultSubForCategory(activeCategory);
    }
    initSidebarCategories();
    initSubFilters();
    renderProducts();
  });

  // Products -> LocalStorage cache
  FB.unsub.prods = _prodsRef().onSnapshot((snap)=>{
    const prods = snap.docs.map(d=>d.data()).filter(Boolean);
    localStorage.setItem(LS_PRODUCTS, JSON.stringify(prods));
    loadAdminData();
    renderProducts();
    renderCart();
    flashStatus("SYNCED FROM ADMIN");
  });

  // Orders (today + yesterday) -> LocalStorage cache for Sales tab
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0,0,0,0);

  FB.unsub.orders = _ordersRef()
    .where("ts", ">=", firebase.firestore.Timestamp.fromDate(start))
    .orderBy("ts", "desc")
    .limit(1500)
    .onSnapshot((snap)=>{
      const orders = snap.docs.map(d=>{
        const x = d.data() || {};
        const tsISO = x.ts?.toDate ? x.ts.toDate().toISOString() : (x.tsISO || x.ts || "");
        return { ...x, ts: tsISO };
      });
      localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
      if (document.getElementById("viewSales")?.classList.contains("active")) {
        refreshSalesView();
      }
    });
}

/* ---------------------- SEED DATA (local fallback only) ---------------------- */
const SEED_CATEGORIES = [
  { name:"Beers", icon:"🍺" },
  { name:"Wines", icon:"🍷" },
  { name:"Energy Drinks", icon:"⚡" },
  { name:"Soft Drinks", icon:"🥤" },
  { name:"Snacks", icon:"🍿" },
];

const SEED_PRODUCTS = [
  { id:"beer_citrushaze", name:"Citrus Haze IPA", category:"Beers", sub:"All Beers", price:130.00, size:"440ml • 5.2%", stock:26, barcode:"100001" },
  { id:"beer_midnight", name:"Midnight Stout", category:"Beers", sub:"Craft", price:72.50, size:"500ml • 8.5%", stock:12, barcode:"100002" },
  { id:"beer_golden", name:"Golden Lager", category:"Beers", sub:"Imported", price:49.90, size:"330ml • 4.5%", stock:49, barcode:"100003" },
  { id:"beer_wheat", name:"Wheat Dream", category:"Beers", sub:"Local", price:60.00, size:"500ml • 5.0%", stock:64, barcode:"100004" },
  { id:"beer_ruby", name:"Ruby Red Ale", category:"Beers", sub:"Craft", price:55.00, size:"400ml • 4.8%", stock:16, barcode:"100005" },
  { id:"beer_juicy", name:"Juicy Pale Ale", category:"Beers", sub:"Draft", price:67.50, size:"440ml • 6.1%", stock:8, barcode:"100006" },
  { id:"wine_red", name:"House Red Wine", category:"Wines", sub:"All", price:180.00, size:"750ml", stock:20, barcode:"200001" },
  { id:"wine_white", name:"House White Wine", category:"Wines", sub:"All", price:160.00, size:"750ml", stock:18, barcode:"200002" },
  { id:"energy_classic", name:"Energy Drink", category:"Energy Drinks", sub:"All", price:25.00, size:"250ml", stock:120, barcode:"300001" },
  { id:"soft_cola", name:"Cola", category:"Soft Drinks", sub:"All", price:15.00, size:"300ml", stock:180, barcode:"400001" },
  { id:"snack_chips", name:"Chips", category:"Snacks", sub:"All", price:19.90, size:"60g", stock:200, barcode:"500001" },
];

/* ---------------------- GLOBAL DATA (loaded from cache) ---------------------- */
let PRODUCTS = [];
let CATEGORIES = [];

/* ---------------------- APP STATE ---------------------- */
let activeCategory = "Beers";
let activeSub = "All";
let searchQuery = "";
let cart = []; // {id,name,price,qty,barcode}
let selectedPayment = "CARD";

/* ---------------------- BOOT ---------------------- */
document.addEventListener("DOMContentLoaded", async () => {

document.getElementById("btnSelectDate")?.remove();
// OR
// document.getElementById("btnSelectDate")?.style.display = "none";



  // ===== Bind "Change Name" button =====
document.getElementById("btnChangeCashierName")?.addEventListener("click", () => {
  const current = getCashierName();
  const next = prompt("Enter Cashier Name:", current);
  if (next === null) return; // cancelled
  if (!setCashierName(next)) {
    alert("Name cannot be empty.");
    return;
  }
  hydrateCashierNameUI();
  alert("Cashier name updated ✅");
});

  // Ensure something exists locally for first paint
  ensureAdminDataSeeded();
  loadAdminData();

  // Firebase sync (if available)
  await fbInit();

  const session = ensureCashierSession();

  bindTopbar(session);
  bindTabs();

  activeCategory = CATEGORIES[0]?.name || "Beers";
  activeSub = defaultSubForCategory(activeCategory);

  initSidebarCategories();
  initSubFilters();
  renderProducts();
  renderCart();
  refreshSalesView();

  setShiftProgress(0.62);
  setActiveTab("terminal");
});

/* ✅ live refresh if Admin edits products/categories in another tab (local fallback) */
window.addEventListener("storage", (e) => {
  if (e.key === LS_PRODUCTS || e.key === LS_CATEGORIES) {
    loadAdminData();

    const exists = CATEGORIES.some(c => c.name === activeCategory);
    if (!exists) {
      activeCategory = CATEGORIES[0]?.name || "Beers";
      activeSub = defaultSubForCategory(activeCategory);
    }

    initSidebarCategories();
    initSubFilters();
    renderProducts();
    renderCart();
    flashStatus("SYNCED FROM ADMIN");
  }
});

/* ---------------------- USB BARCODE SCAN ---------------------- */
let scanBuffer = "";
let scanTimer = null;
const SCAN_TIMEOUT_MS = 60;
const MIN_BARCODE_LEN = 4;

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName?.toLowerCase();
  const typingInInput = tag === "input" || tag === "textarea";
  if (["Shift","Alt","Control","Meta"].includes(e.key)) return;

  if (e.key === "Enter") {
    if (scanBuffer.length >= MIN_BARCODE_LEN) {
      const code = scanBuffer;
      scanBuffer = "";
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;

      const found = PRODUCTS.find(p => String(p.barcode) === String(code));
      if (found) {
        addToCart(found.id, 1);
        flashStatus(`SCANNED: ${code}`);
        if (!document.getElementById("viewTerminal")?.classList.contains("active")) {
          setActiveTab("terminal");
        }
      } else {
        flashStatus(`UNKNOWN BARCODE: ${code}`, true);
      }

      if (typingInInput) e.preventDefault();
    }
    return;
  }

  if (e.key.length === 1) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanBuffer = ""; }, SCAN_TIMEOUT_MS);
    scanBuffer += e.key;
  }
});

/* ---------------------- UI FEEDBACK ---------------------- */
function flashStatus(msg, isError=false){
  const el = document.getElementById("syncStatus");
  if (!el) return;

  el.textContent = msg;
  el.style.borderColor = isError ? "rgba(239,68,68,.35)" : "rgba(22,163,74,.35)";
  el.style.background = isError ? "rgba(239,68,68,.10)" : "rgba(22,163,74,.10)";
  el.style.color = isError ? "#991b1b" : "#166534";

  setTimeout(() => {
    el.textContent = "READY";
    el.style.borderColor = "rgba(22,163,74,.25)";
    el.style.background = "rgba(22,163,74,.10)";
    el.style.color = "#166534";
  }, 1200);
}

/* ---------------------- ADMIN DATA: seed + load (local fallback) ---------------------- */
function ensureAdminDataSeeded(){
  const cats = safeJSON(localStorage.getItem(LS_CATEGORIES), null);
  const prods = safeJSON(localStorage.getItem(LS_PRODUCTS), null);

  if (!cats || !Array.isArray(cats) || cats.length === 0) {
    localStorage.setItem(LS_CATEGORIES, JSON.stringify(SEED_CATEGORIES));
  }
  if (!prods || !Array.isArray(prods) || prods.length === 0) {
    localStorage.setItem(LS_PRODUCTS, JSON.stringify(SEED_PRODUCTS));
  }
}

function loadAdminData(){
  CATEGORIES = safeJSON(localStorage.getItem(LS_CATEGORIES), SEED_CATEGORIES) || [];
  PRODUCTS   = safeJSON(localStorage.getItem(LS_PRODUCTS), SEED_PRODUCTS) || [];
}

/* ---------------------- SESSION ---------------------- */
function ensureCashierSession(){
  let s = safeJSON(localStorage.getItem(LS_SESSION), null);
  if (!s) {
    s = { cashierName: "Alex Johnson", terminal: "Terminal 01" };
    localStorage.setItem(LS_SESSION, JSON.stringify(s));
  }

  const cn = document.getElementById("cashierName");
  const tn = document.getElementById("terminalName");
  const av = document.getElementById("avatar");

  if (cn) cn.textContent = s.cashierName;
  if (tn) tn.textContent = s.terminal;
  if (av) av.textContent = initials(s.cashierName) || "MB";

  return s;
}

function initials(name){
  return String(name||"")
    .split(" ")
    .filter(Boolean)
    .slice(0,2)
    .map(p=>p[0].toUpperCase())
    .join("");
}

/* ---------------------- TOPBAR + TABS ---------------------- */
function bindTopbar(session){
  const inp = document.getElementById("searchInput");
  if (inp){
    inp.addEventListener("input", ()=>{
      searchQuery = inp.value.trim();
      renderProducts();
    });
  }

  document.getElementById("btnClearCart")?.addEventListener("click", ()=>{
    cart = [];
    renderCart();
  });

  document.getElementById("btnCheckout")?.addEventListener("click", ()=> openCheckout(session));
  document.getElementById("btnViewSales")?.addEventListener("click", ()=> setActiveTab("sales"));

  // ✅ Logout
  document.getElementById("logoutBtn")?.addEventListener("click", (e)=>{
    e.preventDefault();
    localStorage.removeItem(LS_SESSION);
    localStorage.removeItem(LS_ADMIN_AUTH);
    localStorage.removeItem(LS_AUTH_BS);
    sessionStorage.removeItem(LS_AUTH_BS);
    if (typeof window.clearSession === "function") { try { window.clearSession(); } catch {} }
    try { if (FB.enabled) firebase.auth().signOut(); } catch {}
    window.location.replace("login.html");
  });
}

function bindTabs(){
  document.getElementById("tabTerminal")?.addEventListener("click", ()=> setActiveTab("terminal"));
  document.getElementById("tabSales")?.addEventListener("click", ()=> setActiveTab("sales"));

  document.getElementById("btnNewOrder")?.addEventListener("click", ()=>{
    setActiveTab("terminal");
    cart = [];
    renderCart();
  });

  document.getElementById("btnGoTerminal")?.addEventListener("click", ()=> setActiveTab("terminal"));
}

/* ✅ Sales tab hides sidebar */
function setActiveTab(which){
  const tabTerminal = document.getElementById("tabTerminal");
  const tabSales    = document.getElementById("tabSales");
  const vTerm       = document.getElementById("viewTerminal");
  const vSales      = document.getElementById("viewSales");
  const shell       = document.querySelector(".shell");

  if (which === "terminal"){
    tabTerminal?.classList.add("active");
    tabSales?.classList.remove("active");
    vTerm?.classList.add("active");
    vSales?.classList.remove("active");
    shell?.classList.remove("salesMode");
  } else {
    refreshSalesView();
    tabSales?.classList.add("active");
    tabTerminal?.classList.remove("active");
    vSales?.classList.add("active");
    vTerm?.classList.remove("active");
    shell?.classList.add("salesMode");
  }
}

/* ---------------------- CATEGORIES + SUBFILTERS (dynamic) ---------------------- */
function initSidebarCategories(){
  const wrap = document.getElementById("categoryList");
  if (!wrap) return;

  wrap.innerHTML = "";
  CATEGORIES.forEach(c=>{
    const btn = document.createElement("button");
    btn.className = "catBtn" + (c.name === activeCategory ? " active" : "");
    btn.innerHTML = `
      <span class="left">
        <span class="catIcon">${escapeHtml(c.icon || "•")}</span> ${escapeHtml(c.name)}
      </span>
      <span style="opacity:.45">›</span>
    `;
    btn.addEventListener("click", ()=>{
      activeCategory = c.name;
      activeSub = defaultSubForCategory(activeCategory);
      initSidebarCategories();
      initSubFilters();
      renderProducts();
    });
    wrap.appendChild(btn);
  });
}

function defaultSubForCategory(cat){
  if (String(cat).toLowerCase() === "beers") return "All Beers";
  return "All";
}

function initSubFilters(){
  const row = document.getElementById("subFilterRow");
  if (!row) return;

  row.innerHTML = "";

  let subs = [];
  if (String(activeCategory).toLowerCase() === "beers") {
    subs = ["All Beers","Craft","Imported","Local","Draft"];
  } else {
    subs = ["All"];
    const uniqueSubs = new Set(
      PRODUCTS
        .filter(p => p.category === activeCategory)
        .map(p => (p.sub || "All"))
        .filter(s => s && s !== "All")
    );
    subs.push(...Array.from(uniqueSubs));
  }

  if (!subs.includes(activeSub)) activeSub = subs[0];

  subs.forEach(s=>{
    const b = document.createElement("button");
    b.className = "pill" + (s === activeSub ? " active" : "");
    b.textContent = s;
    b.addEventListener("click", ()=>{
      activeSub = s;
      initSubFilters();
      renderProducts();
    });
    row.appendChild(b);
  });
}

/* ---------------------- PRODUCTS GRID ---------------------- */
function filteredProducts(){
  return PRODUCTS.filter(p=>{
    if (p.category !== activeCategory) return false;

    if (String(activeCategory).toLowerCase() === "beers") {
      if (activeSub !== "All Beers" && p.sub !== activeSub) return false;
    } else {
      if (activeSub !== "All" && (p.sub || "All") !== activeSub) return false;
    }

    if (searchQuery){
      const q = searchQuery.toLowerCase();
      const hay = (String(p.name||"") + " " + String(p.barcode||"")).toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

function renderProducts(){
  const grid = document.getElementById("productsGrid");
  if (!grid) return;

  const list = filteredProducts();
  grid.innerHTML = "";

  list.forEach((p, i)=>{
    const card = document.createElement("div");
    card.className = "productCard";
    const imgSrc = getProductImage(p, i+1);

    card.innerHTML = `
      <div class="pImg"><img src="${imgSrc}" alt=""/></div>
      <div class="pBody">
        <div class="pName">${escapeHtml(p.name)}</div>
        <div class="pMeta">${escapeHtml(p.size || "")}</div>
        <div class="pBottom">
          <div class="pPrice">${money(p.price)}</div>
          <div class="pStock">Stock ${Number(p.stock||0)}</div>
        </div>
      </div>
    `;

    card.addEventListener("click", ()=> addToCart(p.id, 1));
    grid.appendChild(card);
  });
}

/* ---------------------- CART ---------------------- */
function addToCart(pid, qty=1){
  const p = PRODUCTS.find(x=>x.id===pid);
  if (!p) return;

  const line = cart.find(x=>x.id===pid);
  if (line) line.qty += qty;
  else cart.push({ id:p.id, name:p.name, price:Number(p.price||0), qty:qty, barcode:p.barcode });

  renderCart();
}

function updateQty(pid, delta){
  const line = cart.find(x=>x.id===pid);
  if (!line) return;

  line.qty += delta;
  if (line.qty <= 0) cart = cart.filter(x=>x.id!==pid);
  renderCart();
}

function cartTotals(){
  const subtotal = cart.reduce((s,l)=> s + (l.price*l.qty), 0);
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

function renderCart(){
  const wrap = document.getElementById("cartItems");
  if (!wrap) return;

  wrap.innerHTML = "";

  if (cart.length === 0){
    wrap.innerHTML = `<div style="color:rgba(17,24,39,.55); font-size:12px; padding:12px;">
      No items added yet. Scan a barcode to add items.
    </div>`;
  } else {
    cart.forEach((l, i)=>{
      const prod = PRODUCTS.find(p => p.id === l.id);
      const thumb = getProductImage(prod, i+10);

      const div = document.createElement("div");
      div.className = "cartItem";
      div.innerHTML = `
        <div class="cThumb"><img src="${thumb}" alt=""/></div>
        <div class="cInfo">
          <div class="cName">${escapeHtml(l.name)}</div>
          <div class="cSub">${money(l.price)} / unit</div>
        </div>
        <div class="qtyBox">
          <button class="qtyBtn" data-act="minus">−</button>
          <div class="qtyVal">${l.qty}</div>
          <button class="qtyBtn" data-act="plus">+</button>
        </div>
        <div class="cPrice">${money(l.price*l.qty)}</div>
      `;

      div.querySelector('[data-act="minus"]')?.addEventListener("click", ()=> updateQty(l.id, -1));
      div.querySelector('[data-act="plus"]')?.addEventListener("click", ()=> updateQty(l.id, +1));
      wrap.appendChild(div);
    });
  }

  const {subtotal, tax, total} = cartTotals();
  document.getElementById("subtotal").textContent = money(subtotal);
  document.getElementById("tax").textContent = money(tax);
  document.getElementById("total").textContent = money(total);

  const count = cart.reduce((s,l)=>s+l.qty,0);
  document.getElementById("orderMeta").textContent = cart.length ? `Items: ${count}` : "#—";
}

/* ---------------------- CHECKOUT MODAL ---------------------- */
const overlay        = document.getElementById("checkoutOverlay");
const totalText      = document.getElementById("checkoutTotalText");
const receiptPreview = document.getElementById("receiptPreview");
const cashBox        = document.getElementById("cashBox");
const cashReceived   = document.getElementById("cashReceived");
const cashChange     = document.getElementById("cashChange");

document.getElementById("closeCheckout")?.addEventListener("click", closeCheckout);

document.querySelectorAll(".payBtn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".payBtn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    selectedPayment = btn.dataset.method;

    if (selectedPayment === "CASH"){
      cashBox?.classList.remove("hidden");
      if (cashReceived) cashReceived.value = "";
      if (cashChange) cashChange.textContent = money(0);
    } else {
      cashBox?.classList.add("hidden");
    }

    updateReceiptPreview(window.__SESSION__);
  });
});

cashReceived?.addEventListener("input", ()=>{
  const {total} = cartTotals();
  const rec = parseFloat(cashReceived.value || "0");
  cashChange.textContent = money(Math.max(0, rec - total));
});

document.getElementById("btnConfirmSale")?.addEventListener("click", async ()=>{
  const session = window.__SESSION__;
  if (!cart.length) return;

  const { total } = cartTotals();

  if (selectedPayment === "CASH"){
    const rec = parseFloat(cashReceived.value || "0");
    if (rec < total){
      alert("Cash received is less than total amount.");
      return;
    }
  }

  // ✅ Firestore checkout (transaction: stock decrement + order write)
  try{
    const order = await checkoutAndSave(session, selectedPayment);
    cart = [];
    renderCart();
    closeCheckout();
    refreshSalesView();
    setActiveTab("sales");
  } catch (e){
    alert(e?.message || "Checkout failed");
  }
});

document.getElementById("btnPrint")?.addEventListener("click", ()=> window.print());

function openCheckout(session){
  if (!cart.length){
    alert("Scan items first.");
    return;
  }

  const { total } = cartTotals();
  totalText.textContent = `Total: ${money(total)}`;

  selectedPayment = "CARD";
  document.querySelectorAll(".payBtn").forEach(b=>b.classList.remove("active"));
  document.querySelector('.payBtn[data-method="CARD"]')?.classList.add("active");

  cashBox?.classList.add("hidden");

  window.__SESSION__ = session;
  updateReceiptPreview(session);

  overlay?.classList.remove("hidden");
  overlay?.setAttribute("aria-hidden", "false");
}

function closeCheckout(){
  overlay?.classList.add("hidden");
  overlay?.setAttribute("aria-hidden", "true");
}

function updateReceiptPreview(session){
  if (!session) return;

  const { subtotal, tax, total } = cartTotals();
  const lines = cart.map(l => `${l.qty}x ${l.name} ${money(l.price*l.qty)}`).join("\n");

  receiptPreview.textContent =
`${SHOP_NAME}
${session.terminal} • ${session.cashierName}
--------------------------------
${lines}
--------------------------------
Subtotal: ${money(subtotal)}
Tax (8%): ${money(tax)}
TOTAL:    ${money(total)}
Payment:  ${selectedPayment}

Thank you!`;
}

/* ---------------------- CHECKOUT: Firestore transaction ---------------------- */
/* ---------------------- CHECKOUT: Firestore transaction (FIXED) ---------------------- */
async function checkoutAndSave(session, method){
  // Fallback: LocalStorage-only
  if (!FB.enabled){
    const order = createLocalOrderRecord(session, method);
    saveLocalOrder(order);
    return order;
  }

  const now = new Date();
  const tsISO = now.toISOString();
  const { subtotal, tax, total } = cartTotals();

  const metaRef = _metaRef();

  const result = await FB.db.runTransaction(async (tx) => {
    // ✅ 1) READS FIRST (no writes before this point)
    const productRefs = cart.map(line => _prodsRef().doc(line.id));

    const counterDoc = await tx.get(metaRef);
    const productDocs = await Promise.all(productRefs.map(ref => tx.get(ref)));

    // ✅ 2) Validate after reads
    const last = counterDoc.exists ? Number(counterDoc.data().posSeq || 1020) : 1020;
    const seq = last + 1;

    for (let i = 0; i < cart.length; i++){
      const line = cart[i];
      const pDoc = productDocs[i];

      if (!pDoc.exists) {
        throw new Error(`Product not found: ${line.name}`);
      }

      const stock = Number(pDoc.data().stock || 0);
      if (stock < line.qty){
        throw new Error(`Low stock: ${line.name} (Available: ${stock})`);
      }
    }

    // ✅ 3) WRITES AFTER ALL READS
    tx.set(metaRef, { posSeq: seq }, { merge: true });

    for (let i = 0; i < cart.length; i++){
      const line = cart[i];
      const pRef = productRefs[i];
      const stock = Number(productDocs[i].data().stock || 0);

      tx.update(pRef, {
        stock: stock - line.qty,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    const receiptId = `POS-${seq}`;
    const orderDocId = `${receiptId}_${tsISO.replace(/[:.]/g,"-")}`;

    const order = {
      seq,
      receiptId,
      tsISO,
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      timeLabel: now.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }),
      items: cart.map(l => ({ ...l })),
      method,
      amount: round2(total),
      status: "COMPLETED",
      terminal: session.terminal,
      cashier: session.cashierName,
      subtotal: round2(subtotal),
      tax: round2(tax),
    };

    tx.set(_ordersRef().doc(orderDocId), order, { merge:true });

    // return iso for immediate UI usage
    return { ...order, ts: tsISO };
  });

  // Optimistic local cache (Sales tab instant)
  const orders = loadLocalOrders();
  orders.unshift(result);
  localStorage.setItem(LS_ORDERS, JSON.stringify(orders.slice(0,5000)));

  return result;
}


/* ---------------------- ORDERS + SALES VIEW ---------------------- */
function loadLocalOrders(){
  return safeJSON(localStorage.getItem(LS_ORDERS), []) || [];
}

function saveLocalOrder(order){
  const orders = loadLocalOrders();
  orders.unshift(order);
  localStorage.setItem(LS_ORDERS, JSON.stringify(orders));
}

function createLocalOrderRecord(session, method){
  const now = new Date();
  const prev = loadLocalOrders();
  const idNum = (prev.length ? (prev[0].seq || 1020) + 1 : 1020);
  const receiptId = `POS-${idNum}`;
  const { subtotal, tax, total } = cartTotals();

  return {
    seq: idNum,
    receiptId,
    ts: now.toISOString(),
    timeLabel: now.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }),
    items: cart.map(l => ({...l})),
    method,
    amount: round2(total),
    status: "COMPLETED",
    terminal: session.terminal,
    cashier: session.cashierName,
    subtotal: round2(subtotal),
    tax: round2(tax),
  };
}

function refreshSalesView(){
  const orders = loadLocalOrders();

  const today = new Date();
  const todayKey = today.toISOString().slice(0,10);
  const todays = orders.filter(o => (o.ts||"").slice(0,10) === todayKey);

  const salesDateEl = document.getElementById("salesDate");
  if (salesDateEl){
    salesDateEl.textContent = today.toLocaleDateString("en-IN", { weekday:"long", year:"numeric", month:"short", day:"numeric" });
  }

  const totalSales = todays.reduce((s,o)=> s + (o.amount||0), 0);
  const tx = todays.length;
  const avg = tx ? totalSales/tx : 0;

  document.getElementById("kpiTotalSales").textContent = money(totalSales);
  document.getElementById("kpiTransactions").textContent = String(tx);
  document.getElementById("kpiAvgTicket").textContent = `Avg ${money(avg)} per ticket`;

  const units = new Map();
  for (const o of todays){
    for (const it of (o.items||[])){
      units.set(it.name, (units.get(it.name)||0) + it.qty);
    }
  }

  let topName="—", topUnits=0;
  for (const [k,v] of units.entries()){
    if (v > topUnits){ topUnits=v; topName=k; }
  }

  document.getElementById("kpiTopSeller").textContent = topName;
  document.getElementById("kpiTopSellerSub").textContent = topUnits ? `${topUnits} units sold today` : "—";

  renderSalesTable(todays);
  renderSalesByHour(todays);
}

function renderSalesTable(todays){
  const body = document.getElementById("salesTableBody");
  if (!body) return;

  const q = document.getElementById("salesSearch")?.value?.trim()?.toLowerCase() || "";
  let list = todays;
  if (q) list = list.filter(o => (o.receiptId||"").toLowerCase().includes(q));

  body.innerHTML = "";

  list.forEach(o=>{
    const itemsText =
      (o.items||[]).slice(0,2).map(i=>`${i.qty}x ${i.name}`).join(", ")
      + ((o.items||[]).length > 2 ? `, +${(o.items||[]).length-2} more` : "");

    const tr = document.createElement("div");
    tr.className = "tr";
    tr.innerHTML = `
      <div>${escapeHtml(o.receiptId)}</div>
      <div>${escapeHtml(o.timeLabel || "—")}</div>
      <div style="opacity:.85">${escapeHtml(itemsText)}</div>
      <div>${methodBadge(o.method)}</div>
      <div>${money(o.amount)}</div>
      <div>${statusBadge(o.status)}</div>
      <div><button class="eyeBtn2" title="View">👁</button></div>
    `;

    tr.querySelector(".eyeBtn2")?.addEventListener("click", ()=> alert(orderDetailsText(o)));
    body.appendChild(tr);
  });

  const foot = document.getElementById("tableFoot");
  if (foot) foot.textContent = `Showing ${list.length} of ${todays.length} transactions`;
}

document.getElementById("salesSearch")?.addEventListener("input", refreshSalesView);

function renderSalesByHour(todays){
  const bins = new Array(12).fill(0); // 8AM-8PM

  for (const o of todays){
    const d = new Date(o.ts);
    const h = d.getHours();
    if (h >= 8 && h < 20){
      bins[h-8] += (o.amount || 0);
    }
  }

  const max = Math.max(...bins, 1);
  const chart = document.getElementById("chartBars");
  if (!chart) return;

  chart.innerHTML = "";
  bins.forEach(v=>{
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.round((v/max)*100)}%`;
    chart.appendChild(bar);
  });
}

function orderDetailsText(o){
  const lines = (o.items||[]).map(i=>`${i.qty}x ${i.name} ${money(i.price*i.qty)}`).join("\n");
  return `${SHOP_NAME}
${o.receiptId}
${new Date(o.ts).toLocaleString("en-IN")}

${lines}

Subtotal: ${money(o.subtotal)}
Tax: ${money(o.tax)}
Total: ${money(o.amount)}
Payment: ${o.method}
Status: ${o.status}`;
}

function methodBadge(m){
  if (m === "CARD") return `<span class="badge blue">CARD</span>`;
  if (m === "CASH") return `<span class="badge">CASH</span>`;
  return `<span class="badge">UPI</span>`;
}

function statusBadge(s){
  if (s === "COMPLETED") return `<span class="badge green">COMPLETED</span>`;
  return `<span class="badge red">${escapeHtml(s)}</span>`;
}

/* ---------------------- SHIFT (demo) ---------------------- */
function setShiftProgress(ratio){
  const fill = document.getElementById("shiftFill");
  const meta = document.getElementById("shiftMeta");
  if (fill) fill.style.width = `${Math.max(0, Math.min(1, ratio))*100}%`;
  if (meta) meta.textContent = "8h 12m remaining";
}

/* ---------------------- UTILITIES ---------------------- */
function safeJSON(str, fallback){ try { return JSON.parse(str); } catch { return fallback; } }

function escapeHtml(str){
  return String(str||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function money(n){
  const v = Number(n || 0);
  return v.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
}

function round2(n){
  return Math.round((Number(n)||0) * 100) / 100;
}

/* ✅ Admin-uploaded image if present, else placeholder */
function getProductImage(p, seed){
  if (p && p.image && String(p.image).startsWith("data:image")) {
    return p.image;
  }
  return productImgDataURI(seed);
}

function productImgDataURI(seed) {
  const color = seed % 2 ? "#f6c54a" : "#d8a82f";
  const svg =
`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
  <defs>
    <radialGradient id="g" cx="30%" cy="25%" r="80%">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.75"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.1"/>
    </radialGradient>
  </defs>
  <rect width="120" height="120" rx="22" fill="url(#g)"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="52">🍺</text>
</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}