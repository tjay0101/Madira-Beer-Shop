// auth.js
const AUTH_KEY = "bs_auth_session";

// Create a session object
function setSession({ role, name, remember }) {
  const session = {
    role,
    name,
    ts: Date.now()
  };

  // If "remember", keep in localStorage; else keep in sessionStorage
  if (remember) {
    localStorage.setItem(AUTH_KEY, JSON.stringify(session));
    sessionStorage.removeItem(AUTH_KEY);
  } else {
    sessionStorage.setItem(AUTH_KEY, JSON.stringify(session));
    localStorage.removeItem(AUTH_KEY);
  }
}

function getSession() {
  const a = sessionStorage.getItem(AUTH_KEY);
  const b = localStorage.getItem(AUTH_KEY);
  const raw = a || b;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function clearSession() {
  sessionStorage.removeItem(AUTH_KEY);
  localStorage.removeItem(AUTH_KEY);
}

// Page guard: only allow specified roles
function requireRole(allowedRoles = []) {
  const s = getSession();
  if (!s || (allowedRoles.length && !allowedRoles.includes(s.role))) {
    window.location.href = "index.html";
    return null;
  }
  return s;
}
// auth.js (ADD BELOW YOUR EXISTING CODE)

// Redirect based on role
function goToRoleHome(role) {
  if (role === "admin" || role === "manager") {
    window.location.href = "admin.html";
    return;
  }
  if (role === "cashier") {
    window.location.href = "cashier.html"; // <-- change if your cashier file name is different
    return;
  }
  // fallback
  window.location.href = "login.html";
}

// Optional: simple role label
function roleLabel(role){
  if(role === "admin") return "Admin";
  if(role === "manager") return "Manager";
  if(role === "cashier") return "Cashier";
  return role || "User";
}
