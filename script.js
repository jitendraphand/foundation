function login() {
  const loginId = document.getElementById("loginId").value;
  const password = document.getElementById("password").value;
  const errorMsg = document.getElementById("errorMsg");

  // Dummy check — replace with real authentication if needed
  if (loginId === "admin" && password === "1234") {
    window.location.href = "subjects.html";
  } else {
    errorMsg.textContent = "Invalid Login ID or Password!";
  }
}
