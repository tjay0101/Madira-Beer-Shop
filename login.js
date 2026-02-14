// login.js
// Uses auth.js functions: setSession(), goToRoleHome()

const form = document.getElementById("loginForm");
const errorBox = document.getElementById("errorBox");
const togglePass = document.getElementById("togglePass");
const passEl = document.getElementById("password");

togglePass?.addEventListener("click", () => {
  const isPwd = passEl.type === "password";
  passEl.type = isPwd ? "text" : "password";
  togglePass.textContent = isPwd ? "🙈" : "👁️";
});

// Demo credentials (change these)
const USERS = [
  { id:"admin",   username:"admin",   email:"admin@beershop.com",   password:"admin123",   role:"admin",   name:"Admin" },
  { id:"manager", username:"manager", email:"manager@beershop.com", password:"manager123", role:"manager", name:"Manager" },
  { id:"cashier", username:"cashier", email:"cashier@beershop.com", password:"cashier123", role:"cashier", name:"Cashier" },
];

function findUser(identifier, password){
  const id = (identifier || "").trim().toLowerCase();
  return USERS.find(u => (u.username === id || u.email === id) && u.password === password);
}

function showError(msg){
  errorBox.textContent = msg || "";
}

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  showError("");

  const identifier = document.getElementById("identifier").value;
  const password   = document.getElementById("password").value;
  const remember   = document.getElementById("remember").checked;

  const user = findUser(identifier, password);
  if (!user){
    showError("Invalid username/email or password.");
    return;
  }

  setSession({ role: user.role, name: user.name, remember });
  goToRoleHome(user.role);
});

// If already logged in, redirect automatically
(function autoRedirect(){
  const s = getSession?.();
  if (s?.role) goToRoleHome(s.role);
})();
