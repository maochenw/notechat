(function () {
  // Extract slug from URL: /p/:slug/settings
  const pathParts = window.location.pathname.split("/");
  const slug = pathParts[2];
  if (!slug) {
    window.location.href = "/";
    return;
  }

  const roomUrl = `${window.location.origin}/p/${slug}`;

  // Elements
  const settingsUI = document.getElementById("settings-ui");
  const backLink = document.getElementById("back-link");

  const emailInput = document.getElementById("email-input");
  const btnSendEmail = document.getElementById("btn-send-email");
  const emailStatus = document.getElementById("email-status");

  const codewordSection = document.getElementById("codeword-section");
  const newCodeword = document.getElementById("new-codeword");
  const btnSaveCodeword = document.getElementById("btn-save-codeword");
  const codewordStatus = document.getElementById("codeword-status");

  const btnDelete = document.getElementById("btn-delete");
  const deleteModal = document.getElementById("delete-modal");
  const btnConfirmDelete = document.getElementById("btn-confirm-delete");
  const btnCancelDelete = document.getElementById("btn-cancel-delete");

  let roomHasCodeword = false;

  // Set back link
  backLink.href = `/p/${slug}`;

  // Toggle visibility for new codeword
  document.querySelector(".toggle-new").addEventListener("click", function () {
    const isHidden = newCodeword.type === "password";
    newCodeword.type = isHidden ? "text" : "password";
    this.querySelector(".eye-open").classList.toggle("hidden");
    this.querySelector(".eye-closed").classList.toggle("hidden");
  });

  // Check if room has a codeword, then show settings
  checkAndShow();

  async function checkAndShow() {
    try {
      const res = await fetch("/api/permanent-rooms/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      roomHasCodeword = !!data.hasPassphrase;
    } catch {
      // If check fails, assume no codeword
    }
    showSettings();
  }

  function showSettings() {
    settingsUI.classList.remove("hidden");

    if (roomHasCodeword) {
      codewordSection.classList.add("hidden");
    }
  }

  // --- Email ---
  btnSendEmail.addEventListener("click", sendEmail);
  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendEmail();
  });

  async function sendEmail() {
    const email = emailInput.value.trim();
    if (!email || !email.includes("@")) {
      emailInput.focus();
      return;
    }

    btnSendEmail.disabled = true;
    btnSendEmail.textContent = "Sending…";
    emailStatus.classList.add("hidden");

    try {
      const res = await fetch("/api/email-room-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, roomUrl }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        emailStatus.textContent = data.error || "Could not send email.";
        emailStatus.style.color = "#ef4444";
        emailStatus.classList.remove("hidden");
        btnSendEmail.disabled = false;
        btnSendEmail.textContent = "Send Link";
        return;
      }

      emailStatus.textContent = "Sent! Check your inbox.";
      emailStatus.style.color = "#22c55e";
      emailStatus.classList.remove("hidden");
      btnSendEmail.disabled = false;
      btnSendEmail.textContent = "Send Link";
    } catch {
      emailStatus.textContent = "Network error. Try again.";
      emailStatus.style.color = "#ef4444";
      emailStatus.classList.remove("hidden");
      btnSendEmail.disabled = false;
      btnSendEmail.textContent = "Send Link";
    }
  }

  // --- Codeword ---
  btnSaveCodeword.addEventListener("click", saveCodeword);

  async function saveCodeword() {
    const body = {
      newCodeword: newCodeword.value || null,
    };

    btnSaveCodeword.disabled = true;
    btnSaveCodeword.textContent = "Saving…";
    codewordStatus.classList.add("hidden");

    try {
      const res = await fetch(`/api/permanent-rooms/${encodeURIComponent(slug)}/codeword`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        codewordStatus.textContent = data.error || "Could not set codeword.";
        codewordStatus.style.color = "#ef4444";
        codewordStatus.classList.remove("hidden");
        btnSaveCodeword.disabled = false;
        btnSaveCodeword.textContent = "Save Codeword";
        return;
      }

      if (newCodeword.value && newCodeword.value.trim()) {
        // Codeword was set — hide the section since it's now locked
        codewordStatus.textContent = "Codeword set!";
        codewordStatus.style.color = "#22c55e";
        codewordStatus.classList.remove("hidden");
        btnSaveCodeword.disabled = false;
        btnSaveCodeword.textContent = "Save Codeword";
        roomHasCodeword = true;

        setTimeout(() => {
          codewordSection.classList.add("hidden");
        }, 1500);
      } else {
        codewordStatus.textContent = "No codeword was set.";
        codewordStatus.style.color = "#22c55e";
        codewordStatus.classList.remove("hidden");
        btnSaveCodeword.disabled = false;
        btnSaveCodeword.textContent = "Save Codeword";
      }

      newCodeword.value = "";
    } catch {
      codewordStatus.textContent = "Network error. Try again.";
      codewordStatus.style.color = "#ef4444";
      codewordStatus.classList.remove("hidden");
      btnSaveCodeword.disabled = false;
      btnSaveCodeword.textContent = "Save Codeword";
    }
  }

  // --- Delete ---
  btnDelete.addEventListener("click", () => {
    deleteModal.classList.remove("hidden");
  });

  btnCancelDelete.addEventListener("click", () => {
    deleteModal.classList.add("hidden");
  });

  btnConfirmDelete.addEventListener("click", async () => {
    btnConfirmDelete.disabled = true;
    btnConfirmDelete.textContent = "Deleting…";

    try {
      const res = await fetch(`/api/permanent-rooms/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Could not delete room.");
        btnConfirmDelete.disabled = false;
        btnConfirmDelete.textContent = "Yes, Delete Forever";
        return;
      }

      window.location.href = "/";
    } catch {
      alert("Network error. Please try again.");
      btnConfirmDelete.disabled = false;
      btnConfirmDelete.textContent = "Yes, Delete Forever";
    }
  });
})();
