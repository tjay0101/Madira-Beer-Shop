/* =========================================================
   cashier.js (FULL UPDATED — FIREBASE SOURCE OF TRUTH)
   ✅ Fixes your issue: "deleted products still show after refresh"
   WHY it happened: your old cashier.js was reading LocalStorage cache
   and also re-seeding LocalStorage.

   WHAT THIS VERSION DOES:
   - Products/Categories/Orders come ONLY from Firestore realtime
   - NO products/categories LocalStorage caching
   - If Admin deletes a product doc in Firestore -> it disappears in Cashier instantly
   - Cart auto-removes lines if product got deleted
   - Sales uses Firestore orders snapshot (no LS orders)
   - Cashier Name stored in Firestore: shops/{shopId}/staff/{uid}

   Requirements (Firestore structure):
   shops/{shopId}/categories/{catId}  { name, icon }
   shops/{shopId}/products/{prodId}   { id, name, category, sub, price, size, stock, barcode, image }
   shops/{shopId}/orders/{orderId}    { ...order fields... }
   shops/{shopId}/meta/counters       { posSeq }
   shops/{shopId}/staff/{uid}         { cashierName, terminal }

   ========================================================= */

/* ✅ CHANGE #1: TAX = 0% */
const TAX_RATE = 0.00;

const SHOP_NAME = "Madira Beer Shop";

/* ✅ CHANGE #2 (Logout fix): Clear common session keys to prevent auto-login */
const LS_SESSION = "madira_cashier_session_v1";
const LS_ADMIN_AUTH = "madira_auth_v1";
const LS_AUTH_BS = "bs_auth_session";

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
const FIREBASE_SHOP_ID = "madira";

let FB = {
  enabled: false,
  db: null,
  auth: null,
  uid: null,
  unsub: { cats: null, prods: null, orders: null, staff: null }
};

/* ---------------------- DATA (Firestore -> memory) ---------------------- */
let PRODUCTS = [];
let CATEGORIES = [];
let ORDERS = [];

let activeCategory = "Beers";
let activeSub = "All";
let searchQuery = "";
let cart = []; // {id,name,price,qty,barcode,category,sub,size,image}
let selectedPayment = "CARD";

let SESSION = { cashierName: "Cashier", terminal: "Terminal 01" };

/* ---------------------- BOOT ---------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  // Remove optional date button safely
  document.getElementById("btnSelectDate")?.remove();

  // Change cashier name
  document.getElementById("btnChangeCashierName")?.addEventListener("click", async () => {
    const current = getCashierName();
    const next = prompt("Enter Cashier Name:", current);
    if (next === null) return;
    if (!setCashierName(next)) {
      alert("Name cannot be empty.");
      return;
    }
    await saveStaffProfile().catch(() => {});
    hydrateCashierNameUI();
    alert("Cashier name updated ✅");
  });

  // Init Firebase (required)
  await fbInitOrFail();

  bindTopbar();
  bindTabs();

  // Initial UI
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

/* ---------------------- FIREBASE LOADER ---------------------- */
function _loadScriptOnce(src) {
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

async function ensureFirebaseCompatLoaded() {
  if (window.firebase && firebase.apps) return;
  const v = FIREBASE_CDN_VERSION;
  await _loadScriptOnce(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
  await _loadScriptOnce(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);
  await _loadScriptOnce(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
}

/* ---------------------- FIRESTORE REFS ---------------------- */
function _shopRef() { return FB.db.collection("shops").doc(FIREBASE_SHOP_ID); }
function _catsRef() { return _shopRef().collection("categories"); }
function _prodsRef() { return _shopRef().collection("products"); }
function _ordersRef() { return _shopRef().collection("orders"); }
function _metaRef() { return _shopRef().collection("meta").doc("counters"); }
function _staffRef() { return _shopRef().collection("staff").doc(FB.uid || "unknown"); }

/* ---------------------- FIREBASE INIT ---------------------- */
async function fbInitOrFail() {
  try {
    await ensureFirebaseCompatLoaded();
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);

    FB.auth = firebase.auth();
    FB.db = firebase.firestore();

    if (!FB.auth.currentUser) {
      await FB.auth.signInAnonymously();
    }
    FB.uid = FB.auth.currentUser?.uid || null;
    FB.enabled = true;

    await ensureCountersDoc();
    await ensureStaffDoc();
    startRealtimeSync();

    return true;
  } catch (e) {
    console.error("Firebase init failed:", e);
    FB.enabled = false;
    alert("Firebase connection failed. Cashier cannot run without Firebase.");
    throw e;
  }
}

async function ensureCountersDoc() {
  const doc = await _metaRef().get();
  if (!doc.exists) {
    await _metaRef().set({ posSeq: 1020 }, { merge: true });
  }
}

async function ensureStaffDoc() {
  if (!FB.uid) return;
  const doc = await _staffRef().get();
  if (!doc.exists) {
    await _staffRef().set(
      {
        cashierName: "Alex Johnson",
        terminal: "Terminal 01",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }
  // Load initial
  const d = (await _staffRef().get()).data() || {};
  SESSION.cashierName = String(d.cashierName || "Alex Johnson");
  SESSION.terminal = String(d.terminal || "Terminal 01");
  hydrateCashierUI();
}

/* ---------------------- REALTIME SYNC (Firestore -> memory) ---------------------- */
function startRealtimeSync() {
  stopRealtimeSync();

  // Categories
  FB.unsub.cats = _catsRef().onSnapshot((snap) => {
    CATEGORIES = snap.docs.map(d => d.data()).filter(Boolean);

    const exists = CATEGORIES.some(c => c.name === activeCategory);
    if (!exists) {
      activeCategory = CATEGORIES[0]?.name || "Beers";
      activeSub = defaultSubForCategory(activeCategory);
    }

    initSidebarCategories();
    initSubFilters();
    renderProducts();
  });

  // Products
  FB.unsub.prods = _prodsRef().onSnapshot((snap) => {
    PRODUCTS = snap.docs.map(d => d.data()).filter(Boolean);

    // Force drop cart items that are deleted in Firestore
    const ids = new Set(PRODUCTS.map(p => p.id));
    cart = cart.filter(l => ids.has(l.id));

    initSubFilters();
    renderProducts();
    renderCart();
    flashStatus("SYNCED");
  });

  // Orders (today + yesterday) for sales view
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);

  FB.unsub.orders = _ordersRef()
    .where("ts", ">=", firebase.firestore.Timestamp.fromDate(start))
    .orderBy("ts", "desc")
    .limit(1500)
    .onSnapshot((snap) => {
      ORDERS = snap.docs.map(d => {
        const x = d.data() || {};
        const tsISO = x.ts?.toDate ? x.ts.toDate().toISOString() : (x.tsISO || x.ts || "");
        return { ...x, ts: tsISO };
      });

      if (document.getElementById("viewSales")?.classList.contains("active")) {
        refreshSalesView();
      }
    });

  // Staff profile live
  FB.unsub.staff = _staffRef().onSnapshot((doc) => {
    const d = doc.data() || {};
    if (d.cashierName) SESSION.cashierName = String(d.cashierName);
    if (d.terminal) SESSION.terminal = String(d.terminal);
    hydrateCashierUI();
  });
}

function stopRealtimeSync() {
  try { FB.unsub.cats?.(); } catch {}
  try { FB.unsub.prods?.(); } catch {}
  try { FB.unsub.orders?.(); } catch {}
  try { FB.unsub.staff?.(); } catch {}
  FB.unsub = { cats: null, prods: null, orders: null, staff: null };
}

/* ---------------------- CASHIER NAME HELPERS ---------------------- */
function getCashierName() {
  return String(SESSION.cashierName || "Alex Johnson");
}

function setCashierName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  SESSION.cashierName = n;
  return true;
}

function hydrateCashierNameUI() {
  const nameEl = document.getElementById("cashierName");
  if (nameEl) nameEl.textContent = getCashierName();
  const av = document.getElementById("avatar");
  if (av) av.textContent = initials(getCashierName()) || "MB";
}

function hydrateCashierUI() {
  const cn = document.getElementById("cashierName");
  const tn = document.getElementById("terminalName");
  const av = document.getElementById("avatar");

  if (cn) cn.textContent = SESSION.cashierName || "Alex Johnson";
  if (tn) tn.textContent = SESSION.terminal || "Terminal 01";
  if (av) av.textContent = initials(SESSION.cashierName) || "MB";
}

async function saveStaffProfile() {
  if (!FB.enabled || !FB.uid) return;
  await _staffRef().set(
    {
      cashierName: SESSION.cashierName,
      terminal: SESSION.terminal,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

/* ---------------------- USB BARCODE SCAN ---------------------- */
let scanBuffer = "";
let scanTimer = null;
const SCAN_TIMEOUT_MS = 60;
const MIN_BARCODE_LEN = 4;

window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName?.toLowerCase();
  const typingInInput = tag === "input" || tag === "textarea";
  if (["Shift", "Alt", "Control", "Meta"].includes(e.key)) return;

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
function flashStatus(msg, isError = false) {
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

/* ---------------------- TOPBAR + TABS ---------------------- */
function bindTopbar() {
  const inp = document.getElementById("searchInput");
  if (inp) {
    inp.addEventListener("input", () => {
      searchQuery = inp.value.trim();
      renderProducts();
    });
  }

  document.getElementById("btnClearCart")?.addEventListener("click", () => {
    cart = [];
    renderCart();
  });

  document.getElementById("btnCheckout")?.addEventListener("click", () => openCheckout());
  document.getElementById("btnViewSales")?.addEventListener("click", () => setActiveTab("sales"));

  /* ✅ CHANGE #2: LOGOUT FIX (only this block changed) */
  document.getElementById("logoutBtn")?.addEventListener("click", async (e) => {
    e.preventDefault();

    // stop Firestore listeners so nothing “re-hydrates” UI while redirecting
    try { stopRealtimeSync(); } catch {}

    // clear your app/session keys (this prevents auto-login loops)
    try { localStorage.removeItem(LS_SESSION); } catch {}
    try { localStorage.removeItem(LS_ADMIN_AUTH); } catch {}
    try { localStorage.removeItem(LS_AUTH_BS); } catch {}
    try { sessionStorage.removeItem(LS_AUTH_BS); } catch {}

    // sign out firebase user (anonymous too)
    try { if (FB.enabled) await firebase.auth().signOut(); } catch {}

    // hard redirect
    window.location.href = "login.html?loggedout=1";
  });
}

function bindTabs() {
  document.getElementById("tabTerminal")?.addEventListener("click", () => setActiveTab("terminal"));
  document.getElementById("tabSales")?.addEventListener("click", () => setActiveTab("sales"));

  document.getElementById("btnNewOrder")?.addEventListener("click", () => {
    setActiveTab("terminal");
    cart = [];
    renderCart();
  });

  document.getElementById("btnGoTerminal")?.addEventListener("click", () => setActiveTab("terminal"));
}

/* ✅ Sales tab hides sidebar */
function setActiveTab(which) {
  const tabTerminal = document.getElementById("tabTerminal");
  const tabSales = document.getElementById("tabSales");
  const vTerm = document.getElementById("viewTerminal");
  const vSales = document.getElementById("viewSales");
  const shell = document.querySelector(".shell");

  if (which === "terminal") {
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

/* ---------------------- CATEGORIES + SUBFILTERS ---------------------- */
function initSidebarCategories() {
  const wrap = document.getElementById("categoryList");
  if (!wrap) return;

  wrap.innerHTML = "";
  CATEGORIES.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "catBtn" + (c.name === activeCategory ? " active" : "");
    btn.innerHTML = `
      <span class="left">
        <span class="catIcon">${escapeHtml(c.icon || "•")}</span> ${escapeHtml(c.name)}
      </span>
      <span style="opacity:.45">›</span>
    `;
    btn.addEventListener("click", () => {
      activeCategory = c.name;
      activeSub = defaultSubForCategory(activeCategory);
      initSidebarCategories();
      initSubFilters();
      renderProducts();
    });
    wrap.appendChild(btn);
  });
}

function defaultSubForCategory(cat) {
  if (String(cat).toLowerCase() === "beers") return "All Beers";
  return "All";
}

function initSubFilters() {
  const row = document.getElementById("subFilterRow");
  if (!row) return;

  row.innerHTML = "";

  let subs = [];
  if (String(activeCategory).toLowerCase() === "beers") {
    subs = ["All Beers", "Craft", "Imported", "Local", "Draft"];
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

  subs.forEach(s => {
    const b = document.createElement("button");
    b.className = "pill" + (s === activeSub ? " active" : "");
    b.textContent = s;
    b.addEventListener("click", () => {
      activeSub = s;
      initSubFilters();
      renderProducts();
    });
    row.appendChild(b);
  });
}

/* ---------------------- PRODUCTS GRID ---------------------- */
function filteredProducts() {
  return PRODUCTS.filter(p => {
    if (p.category !== activeCategory) return false;

    if (String(activeCategory).toLowerCase() === "beers") {
      if (activeSub !== "All Beers" && p.sub !== activeSub) return false;
    } else {
      if (activeSub !== "All" && (p.sub || "All") !== activeSub) return false;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const hay = (String(p.name || "") + " " + String(p.barcode || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

function renderProducts() {
  const grid = document.getElementById("productsGrid");
  if (!grid) return;

  const list = filteredProducts();
  grid.innerHTML = "";

  list.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "productCard";
    const imgSrc = getProductImage(p, i + 1);

    card.innerHTML = `
      <div class="pImg"><img src="${imgSrc}" alt=""/></div>
      <div class="pBody">
        <div class="pName">${escapeHtml(p.name)}</div>
        <div class="pMeta">${escapeHtml(p.size || "")}</div>
        <div class="pBottom">
          <div class="pPrice">${money(p.price)}</div>
          <div class="pStock">Stock ${Number(p.stock || 0)}</div>
        </div>
      </div>
    `;

    card.addEventListener("click", () => addToCart(p.id, 1));
    grid.appendChild(card);
  });
}

/* ---------------------- CART ---------------------- */
function addToCart(pid, qty = 1) {
  const p = PRODUCTS.find(x => x.id === pid);
  if (!p) return;

  const line = cart.find(x => x.id === pid);
  if (line) line.qty += qty;
  else {
    cart.push({
      id: p.id,
      name: p.name,
      price: Number(p.price || 0),
      qty: qty,
      barcode: p.barcode,
      category: p.category || "",
      sub: p.sub || "",
      size: p.size || "",
      image: p.image || null
    });
  }

  renderCart();
}

function updateQty(pid, delta) {
  const line = cart.find(x => x.id === pid);
  if (!line) return;

  line.qty += delta;
  if (line.qty <= 0) cart = cart.filter(x => x.id !== pid);
  renderCart();
}

function cartTotals() {
  const subtotal = cart.reduce((s, l) => s + (l.price * l.qty), 0);

  /* ✅ CHANGE #1 continued: tax always zero */
  const tax = 0;

  const total = subtotal + tax;
  return { subtotal, tax, total };
}

function renderCart() {
  const wrap = document.getElementById("cartItems");
  if (!wrap) return;

  // drop deleted products (if any)
  const ids = new Set(PRODUCTS.map(p => p.id));
  cart = cart.filter(l => ids.has(l.id));

  wrap.innerHTML = "";

  if (cart.length === 0) {
    wrap.innerHTML = `<div style="color:rgba(17,24,39,.55); font-size:12px; padding:12px;">
      No items added yet. Scan a barcode to add items.
    </div>`;
  } else {
    cart.forEach((l, i) => {
      const prod = PRODUCTS.find(p => p.id === l.id);
      const thumb = getProductImage(prod, i + 10);

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
        <div class="cPrice">${money(l.price * l.qty)}</div>
      `;

      div.querySelector('[data-act="minus"]')?.addEventListener("click", () => updateQty(l.id, -1));
      div.querySelector('[data-act="plus"]')?.addEventListener("click", () => updateQty(l.id, +1));
      wrap.appendChild(div);
    });
  }

  const { subtotal, tax, total } = cartTotals();
  document.getElementById("subtotal").textContent = money(subtotal);

  // keep existing UI element, just show 0 tax
  document.getElementById("tax").textContent = money(tax);

  document.getElementById("total").textContent = money(total);

  const count = cart.reduce((s, l) => s + l.qty, 0);
  document.getElementById("orderMeta").textContent = cart.length ? `Items: ${count}` : "#—";
}

/* ---------------------- CHECKOUT MODAL ---------------------- */
const overlay = document.getElementById("checkoutOverlay");
const totalText = document.getElementById("checkoutTotalText");
const receiptPreview = document.getElementById("receiptPreview");
const cashBox = document.getElementById("cashBox");
const cashReceived = document.getElementById("cashReceived");
const cashChange = document.getElementById("cashChange");

document.getElementById("closeCheckout")?.addEventListener("click", closeCheckout);

document.querySelectorAll(".payBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".payBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedPayment = btn.dataset.method;

    if (selectedPayment === "CASH") {
      cashBox?.classList.remove("hidden");
      if (cashReceived) cashReceived.value = "";
      if (cashChange) cashChange.textContent = money(0);
    } else {
      cashBox?.classList.add("hidden");
    }

    updateReceiptPreview();
  });
});

cashReceived?.addEventListener("input", () => {
  const { total } = cartTotals();
  const rec = parseFloat(cashReceived.value || "0");
  cashChange.textContent = money(Math.max(0, rec - total));
});

document.getElementById("btnConfirmSale")?.addEventListener("click", async () => {
  if (!cart.length) return;

  const { total } = cartTotals();

  if (selectedPayment === "CASH") {
    const rec = parseFloat(cashReceived.value || "0");
    if (rec < total) {
      alert("Cash received is less than total amount.");
      return;
    }
  }

  try {
    await checkoutAndSave(selectedPayment);
    cart = [];
    renderCart();
    closeCheckout();
    refreshSalesView();
    setActiveTab("sales");
  } catch (e) {
    alert(e?.message || "Checkout failed");
  }
});

document.getElementById("btnPrint")?.addEventListener("click", () => window.print());

function openCheckout() {
  if (!cart.length) {
    alert("Scan items first.");
    return;
  }

  const { total } = cartTotals();
  totalText.textContent = `Total: ${money(total)}`;

  selectedPayment = "CARD";
  document.querySelectorAll(".payBtn").forEach(b => b.classList.remove("active"));
  document.querySelector('.payBtn[data-method="CARD"]')?.classList.add("active");

  cashBox?.classList.add("hidden");
  updateReceiptPreview();

  overlay?.classList.remove("hidden");
  overlay?.setAttribute("aria-hidden", "false");
}

function closeCheckout() {
  overlay?.classList.add("hidden");
  overlay?.setAttribute("aria-hidden", "true");
}

function updateReceiptPreview() {
  const { subtotal, tax, total } = cartTotals();
  const lines = cart.map(l => `${l.qty}x ${l.name} ${money(l.price * l.qty)}`).join("\n");

  receiptPreview.textContent =
`${SHOP_NAME}
${SESSION.terminal} • ${SESSION.cashierName}
--------------------------------
${lines}
--------------------------------
Subtotal: ${money(subtotal)}
Tax:      ${money(tax)}
TOTAL:    ${money(total)}
Payment:  ${selectedPayment}

Thank you!`;
}

/* ---------------------- CHECKOUT: Firestore transaction ---------------------- */
async function checkoutAndSave(method) {
  if (!FB.enabled) throw new Error("Firebase not available");

  const now = new Date();
  const tsISO = now.toISOString();
  const { subtotal, tax, total } = cartTotals();

  const metaRef = _metaRef();

  const result = await FB.db.runTransaction(async (tx) => {
    // READS FIRST
    const productRefs = cart.map(line => _prodsRef().doc(line.id));
    const counterDoc = await tx.get(metaRef);
    const productDocs = await Promise.all(productRefs.map(ref => tx.get(ref)));

    const last = counterDoc.exists ? Number(counterDoc.data().posSeq || 1020) : 1020;
    const seq = last + 1;

    for (let i = 0; i < cart.length; i++) {
      const line = cart[i];
      const pDoc = productDocs[i];

      if (!pDoc.exists) throw new Error(`Product removed: ${line.name}`);

      const stock = Number(pDoc.data().stock || 0);
      if (stock < line.qty) throw new Error(`Low stock: ${line.name} (Available: ${stock})`);
    }

    // WRITES AFTER READS
    tx.set(metaRef, { posSeq: seq }, { merge: true });

    for (let i = 0; i < cart.length; i++) {
      const line = cart[i];
      const pRef = productRefs[i];
      const stock = Number(productDocs[i].data().stock || 0);

      tx.update(pRef, {
        stock: stock - line.qty,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    const receiptId = `POS-${seq}`;
    const orderDocId = `${receiptId}_${tsISO.replace(/[:.]/g, "-")}`;

    const order = {
      seq,
      receiptId,
      tsISO,
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      timeLabel: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      items: cart.map(l => ({
        id: l.id,
        name: l.name,
        price: Number(l.price || 0),
        qty: Number(l.qty || 0),
        barcode: l.barcode || "",
        category: l.category || "",
        sub: l.sub || "",
        size: l.size || ""
      })),
      method,
      amount: round2(total),
      status: "COMPLETED",
      terminal: SESSION.terminal,
      cashier: SESSION.cashierName,
      subtotal: round2(subtotal),
      tax: round2(tax)
    };

    tx.set(_ordersRef().doc(orderDocId), order, { merge: true });
    return { ...order, ts: tsISO };
  });

  // optimistic UI (not required, but instant)
  ORDERS.unshift(result);
  return result;
}

/* ---------------------- SALES VIEW (Firestore orders in memory) ---------------------- */
function refreshSalesView() {
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const todays = ORDERS.filter(o => (o.ts || "").slice(0, 10) === todayKey);

  const salesDateEl = document.getElementById("salesDate");
  if (salesDateEl) {
    salesDateEl.textContent = today.toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "short", day: "numeric" });
  }

  const totalSales = todays.reduce((s, o) => s + (o.amount || 0), 0);
  const txCount = todays.length;
  const avg = txCount ? totalSales / txCount : 0;

  document.getElementById("kpiTotalSales").textContent = money(totalSales);
  document.getElementById("kpiTransactions").textContent = String(txCount);
  document.getElementById("kpiAvgTicket").textContent = `Avg ${money(avg)} per ticket`;

  const units = new Map();
  for (const o of todays) {
    for (const it of (o.items || [])) {
      units.set(it.name, (units.get(it.name) || 0) + it.qty);
    }
  }

  let topName = "—", topUnits = 0;
  for (const [k, v] of units.entries()) {
    if (v > topUnits) { topUnits = v; topName = k; }
  }

  document.getElementById("kpiTopSeller").textContent = topName;
  document.getElementById("kpiTopSellerSub").textContent = topUnits ? `${topUnits} units sold today` : "—";

  renderSalesTable(todays);
  renderSalesByHour(todays);
}

function renderSalesTable(todays) {
  const body = document.getElementById("salesTableBody");
  if (!body) return;

  const q = document.getElementById("salesSearch")?.value?.trim()?.toLowerCase() || "";
  let list = todays;
  if (q) list = list.filter(o => (o.receiptId || "").toLowerCase().includes(q));

  body.innerHTML = "";

  list.forEach(o => {
    const itemsText =
      (o.items || []).slice(0, 2).map(i => `${i.qty}x ${i.name}`).join(", ")
      + ((o.items || []).length > 2 ? `, +${(o.items || []).length - 2} more` : "");

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

    tr.querySelector(".eyeBtn2")?.addEventListener("click", () => alert(orderDetailsText(o)));
    body.appendChild(tr);
  });

  const foot = document.getElementById("tableFoot");
  if (foot) foot.textContent = `Showing ${list.length} of ${todays.length} transactions`;
}

document.getElementById("salesSearch")?.addEventListener("input", refreshSalesView);

function renderSalesByHour(todays) {
  const bins = new Array(12).fill(0); // 8AM-8PM
  for (const o of todays) {
    const d = new Date(o.ts);
    const h = d.getHours();
    if (h >= 8 && h < 20) bins[h - 8] += (o.amount || 0);
  }

  const max = Math.max(...bins, 1);
  const chart = document.getElementById("chartBars");
  if (!chart) return;

  chart.innerHTML = "";
  bins.forEach(v => {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.round((v / max) * 100)}%`;
    chart.appendChild(bar);
  });
}

function orderDetailsText(o) {
  const lines = (o.items || []).map(i => `${i.qty}x ${i.name} ${money(i.price * i.qty)}`).join("\n");
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

function methodBadge(m) {
  if (m === "CARD") return `<span class="badge blue">CARD</span>`;
  if (m === "CASH") return `<span class="badge">CASH</span>`;
  return `<span class="badge">UPI</span>`;
}

function statusBadge(s) {
  if (s === "COMPLETED") return `<span class="badge green">COMPLETED</span>`;
  return `<span class="badge red">${escapeHtml(s)}</span>`;
}

/* ---------------------- SHIFT (demo) ---------------------- */
function setShiftProgress(ratio) {
  const fill = document.getElementById("shiftFill");
  const meta = document.getElementById("shiftMeta");
  if (fill) fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  if (meta) meta.textContent = "8h 12m remaining";
}

/* ---------------------- UTILITIES ---------------------- */
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function initials(name) {
  return String(name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0].toUpperCase())
    .join("");
}

/* ✅ Admin-uploaded image if present, else placeholder */
function getProductImage(p, seed) {
  if (p && p.image && String(p.image).startsWith("data:image")) return p.image;
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
