import "./style.css";

// Check if redirect contains an error parameter (e.g. ?error=invalid-login)
const urlParams = new URLSearchParams(window.location.search);
const error = urlParams.get("error");

if (error) {
  const card = document.querySelector<HTMLElement>(".login-card");
  if (card) {
    const errorToast = document.createElement("div");
    errorToast.className = "login-error-toast";
    errorToast.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <span>${error === "invalid-login" ? "Authentication session state expired. Please try signing in again." : "Sign in attempt failed. Please check your credentials."}</span>
    `;
    card.insertBefore(errorToast, card.querySelector(".action-wrapper"));
  }
}
