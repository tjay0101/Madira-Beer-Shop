/* =========================================================
   cashier.js (FIREBASE SOURCE OF TRUTH)
   - Firestore realtime for Products/Categories/Orders/Staff
   - NO LocalStorage cache for products/categories
   - Cart auto-removes deleted products
   - Sales uses Firestore orders snapshot (memory)
   - Cashier name stored in: shops/{shopId}/staff/{uid}

   ✅ FIXES INCLUDED
   1) TAX = 0%  (GST removed)
   2) Total always updates
   3) Logout is HARD + clears auth/session keys
   4) Sub + Variant filters in ONE LINE + ONE All tab only
   5) Selecting Sub will NOT hide Variants (650ml stays), and vice-versa
   6) ✅ Barcode scanner auto-add (keyboard-wedge)
   7) ✅ COMPLETE SALE directly completes (no payment modal)

========================================================= */

const TAX_RATE = 0.00;
const SHOP_NAME = "Madira Beer Shop";

/* ✅ Default payment for direct checkout (no modal) */
const DEFAULT_PAYMENT_METHOD = "CARD"; // change to "CASH" or "UPI" if you want

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

/* ✅ Filters */
let activeCategory = "Beers";
let activeSub = "All";
let activeVariant = "All";
let searchQuery = "";

/* Cart */
let cart = []; // {id,name,price,qty,barcode,category,sub,size,image}
let selectedPayment = DEFAULT_PAYMENT_METHOD;

let SESSION = { cashierName: "Cashier", terminal: "Terminal 01" };

/* ---------------------- BOOT ---------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("btnSelectDate")?.remove();

  // Init Firebase (required)
  await fbInitOrFail();

  bindTopbar();
  bindTabs();

  // ✅ Barcode scan handler (must be attached after PRODUCTS will load too)
  bindBarcodeScanner();

  // Initial UI
  activeCategory = CATEGORIES[0]?.name || "Beers";
  activeSub = "All";
  activeVariant = "All";

  initSidebarCategories();
  initUnifiedFilters();
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
  const d = (await _staffRef().get()).data() || {};
  SESSION.cashierName = String(d.cashierName || "Alex Johnson");
  SESSION.terminal = String(d.terminal || "Terminal 01");
  hydrateCashierUI();
}

/* ---------------------- REALTIME SYNC ---------------------- */
function startRealtimeSync() {
  stopRealtimeSync();

  // Categories
  FB.unsub.cats = _catsRef().onSnapshot((snap) => {
    CATEGORIES = snap.docs.map(d => d.data()).filter(Boolean);

    const exists = CATEGORIES.some(c => c.name === activeCategory);
    if (!exists) {
      activeCategory = CATEGORIES[0]?.name || "Beers";
      activeSub = "All";
      activeVariant = "All";
    }

    initSidebarCategories();
    initUnifiedFilters();
    renderProducts();
  });

  // Products
  FB.unsub.prods = _prodsRef().onSnapshot((snap) => {
    PRODUCTS = snap.docs.map(d => d.data()).filter(Boolean);

    // Drop cart items deleted in Firestore
    const ids = new Set(PRODUCTS.map(p => p.id));
    cart = cart.filter(l => ids.has(l.id));

    initUnifiedFilters();
    renderProducts();
    renderCart();
    flashStatus("SYNCED");
  });

  // Orders (today + yesterday)
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

  // Staff profile
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

/* ---------------------- HARD LOGOUT ---------------------- */
async function hardLogout() {
  try { stopRealtimeSync(); } catch {}
  try { cart = []; renderCart(); } catch {}

  try {
    const killPrefixes = ["madira", "mb_", "MB_", "bs_", "BS_"];
    const killExact = [
      "madira_auth_v1",
      "bs_auth_session",
      "madira_cashier_session_v1",
      "madira_orders_v1",
      "user",
      "role",
      "token",
      "session"
    ];

    killExact.forEach(k => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });

    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (killPrefixes.some(p => k.startsWith(p))) localStorage.removeItem(k);
    }
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (!k) continue;
      if (killPrefixes.some(p => k.startsWith(p))) sessionStorage.removeItem(k);
    }
  } catch {}

  try {
    if (window.firebase?.auth) await firebase.auth().signOut();
  } catch {}

  window.location.href = "login.html";
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

  /* ✅ COMPLETE SALE now directly completes checkout (no modal) */
  document.getElementById("btnCheckout")?.addEventListener("click", async () => {
    if (!cart.length) {
      alert("Scan items first.");
      return;
    }
    try {
      flashStatus("SAVING...");
      await checkoutAndSave(DEFAULT_PAYMENT_METHOD);
      cart = [];
      renderCart();
      refreshSalesView();
      setActiveTab("sales");
      flashStatus("COMPLETED");
    } catch (e) {
      console.error(e);
      alert(e?.message || "Checkout failed");
      flashStatus("FAILED", true);
    }
  });

  document.getElementById("btnViewSales")?.addEventListener("click", () => setActiveTab("sales"));

  // logout
  const btn = document.getElementById("logoutBtn");
  if (btn) {
    btn.setAttribute("onclick", "window.__HARD_LOGOUT__ && window.__HARD_LOGOUT__()");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hardLogout();
    });
  }

  document.addEventListener("click", (e) => {
    const hit = e.target?.closest?.("#logoutBtn");
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    hardLogout();
  }, true);

  window.__HARD_LOGOUT__ = hardLogout;

  /* ✅ Hide/disable checkout modal if it exists in HTML (so it won't interfere) */
  const overlay = document.getElementById("checkoutOverlay");
  if (overlay) {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
  }
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

/* ---------------------- SIDEBAR CATEGORIES ---------------------- */
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
      activeSub = "All";
      activeVariant = "All";
      initSidebarCategories();
      initUnifiedFilters();
      renderProducts();
    });
    wrap.appendChild(btn);
  });
}

/* ---------------------- ✅ ONE-LINE SUB + VARIANT FILTERS ---------------------- */
function initUnifiedFilters() {
  const row = document.getElementById("subFilterRow");
  if (!row) return;

  const vr = document.getElementById("variantFilterRow");
  if (vr) vr.style.display = "none";

  row.innerHTML = "";

  const catProducts = PRODUCTS.filter(p => p.category === activeCategory);

  const subs = Array.from(new Set(
    catProducts.map(p => String(p.sub || "").trim()).filter(Boolean)
  ));

  const variants = Array.from(new Set(
    catProducts.map(p => String(p.size || "").trim()).filter(Boolean)
  ));

  if (activeSub !== "All" && !subs.includes(activeSub)) activeSub = "All";
  if (activeVariant !== "All" && !variants.includes(activeVariant)) activeVariant = "All";

  row.appendChild(makePill("All", (activeSub === "All" && activeVariant === "All"), () => {
    activeSub = "All";
    activeVariant = "All";
    initUnifiedFilters();
    renderProducts();
  }));

  subs.forEach(s => {
    row.appendChild(makePill(s, activeSub === s, () => {
      activeSub = s;
      initUnifiedFilters();
      renderProducts();
    }));
  });

  variants.forEach(v => {
    row.appendChild(makePill(v, activeVariant === v, () => {
      activeVariant = v;
      initUnifiedFilters();
      renderProducts();
    }));
  });
}

function makePill(text, isActive, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pill" + (isActive ? " active" : "");
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

/* ---------------------- PRODUCTS GRID ---------------------- */
function filteredProducts() {
  return PRODUCTS.filter(p => {
    if (p.category !== activeCategory) return false;
    if (activeSub !== "All" && String(p.sub || "").trim() !== activeSub) return false;
    if (activeVariant !== "All" && String(p.size || "").trim() !== activeVariant) return false;

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
  const subtotal = cart.reduce((s, l) => s + (Number(l.price || 0) * Number(l.qty || 0)), 0);
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

function renderCart() {
  const wrap = document.getElementById("cartItems");
  if (!wrap) return;

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
          <button class="qtyBtn" data-act="minus" type="button">−</button>
          <div class="qtyVal">${l.qty}</div>
          <button class="qtyBtn" data-act="plus" type="button">+</button>
        </div>
        <div class="cPrice">${money(l.price * l.qty)}</div>
      `;

      div.querySelector('[data-act="minus"]')?.addEventListener("click", () => updateQty(l.id, -1));
      div.querySelector('[data-act="plus"]')?.addEventListener("click", () => updateQty(l.id, +1));
      wrap.appendChild(div);
    });
  }

  const { subtotal, total } = cartTotals();
  document.getElementById("subtotal").textContent = money(subtotal);
  document.getElementById("total").textContent = money(total);

  const count = cart.reduce((s, l) => s + l.qty, 0);
  const meta = document.getElementById("orderMeta");
  if (meta) meta.textContent = cart.length ? `Items: ${count}` : "#—";
}

/* =========================================================
   ✅ BARCODE SCANNER AUTO-ADD (keyboard wedge scanners)
   - Most barcode scanners type digits fast + press Enter
   - This captures fast keystream even if focus isn't on input
========================================================= */
function bindBarcodeScanner() {
  let buf = "";
  let timer = null;
  const TIMEOUT_MS = 50;      // scanner is fast; human typing is slower
  const MIN_LEN = 4;

  window.addEventListener("keydown", (e) => {
    // ignore if ctrl/alt/meta combos
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // If user is typing in an input/textarea, still allow scanner
    // but ignore normal letters except digits (most barcodes are numeric)
    const k = e.key;

    if (k === "Enter") {
      if (buf.length >= MIN_LEN) {
        const code = buf;
        buf = "";
        if (timer) clearTimeout(timer);
        timer = null;

        const found = PRODUCTS.find(p => String(p.barcode || "").trim() === String(code).trim());
        if (found) {
          addToCart(found.id, 1);
          flashStatus(`SCANNED: ${code}`);
          // keep on terminal
          if (!document.getElementById("viewTerminal")?.classList.contains("active")) {
            setActiveTab("terminal");
          }
        } else {
          flashStatus(`UNKNOWN: ${code}`, true);
        }

        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    // accept only printable characters; prefer digits
    if (k.length === 1) {
      // reset timer
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { buf = ""; }, TIMEOUT_MS);

      // If you want to accept alphabets too, remove this check
      // Most barcodes are numeric, so this avoids capturing human typing
      if (/^[0-9]$/.test(k)) {
        buf += k;
      } else {
        // If barcode contains letters, allow them too by uncommenting:
        // buf += k;
      }
    }
  }, true);
}

/* ---------------------- CHECKOUT: Firestore transaction ---------------------- */
async function checkoutAndSave(method) {
  if (!FB.enabled) throw new Error("Firebase not available");

  const now = new Date();
  const tsISO = now.toISOString();
  const { subtotal, tax, total } = cartTotals();

  const metaRef = _metaRef();

  const result = await FB.db.runTransaction(async (tx) => {
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

  ORDERS.unshift(result);
  return result;
}

/* ---------------------- SALES VIEW ---------------------- */
function refreshSalesView() {
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const todays = ORDERS.filter(o => (o.ts || "").slice(0, 10) === todayKey);

  const salesDateEl = document.getElementById("salesDate");
  if (salesDateEl) {
    salesDateEl.textContent = today.toLocaleDateString("en-IN", {
      weekday: "long", year: "numeric", month: "short", day: "numeric"
    });
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
      <div><button class="eyeBtn2" title="View" type="button">👁</button></div>
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

/* ---------------------- CASHIER UI ---------------------- */
function hydrateCashierUI() {
  const cn = document.getElementById("cashierName");
  const tn = document.getElementById("terminalName");
  const av = document.getElementById("avatar");

  if (cn) cn.textContent = SESSION.cashierName || "Alex Johnson";
  if (tn) tn.textContent = SESSION.terminal || "Terminal 01";
  if (av) av.textContent = initials(SESSION.cashierName) || "MB";
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
