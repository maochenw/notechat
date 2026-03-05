(function () {
  const inputSlug = document.getElementById("input-slug");
  const slugStatus = document.getElementById("slug-status");
  const inputPassphrase = document.getElementById("input-passphrase");
  const btnToggleCodeword = document.getElementById("btn-toggle-codeword");
  const inputName = document.getElementById("input-name");
  const btnCreate = document.getElementById("btn-create");

  let slugCheckTimeout = null;
  let slugAvailable = false;

  // Toggle codeword visibility
  btnToggleCodeword.addEventListener("click", () => {
    const isHidden = inputPassphrase.type === "password";
    inputPassphrase.type = isHidden ? "text" : "password";
    btnToggleCodeword.querySelector(".eye-open").classList.toggle("hidden");
    btnToggleCodeword.querySelector(".eye-closed").classList.toggle("hidden");
  });

  // Get session_id from URL (present after Stripe redirect, absent in testing mode)
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");

  // In production, session_id is required
  // In testing mode (no session_id), the server auto-approves
  // We can't easily detect testing mode client-side, so we allow both cases
  // and let the server decide

  // --- Slug availability checking with debounce ---
  inputSlug.addEventListener("input", () => {
    clearTimeout(slugCheckTimeout);
    const raw = inputSlug.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    inputSlug.value = raw;

    slugAvailable = false;
    updateCreateButton();

    if (raw.length < 3) {
      slugStatus.textContent = raw.length > 0 ? "At least 3 characters" : "";
      slugStatus.className = "slug-status slug-status-error";
      return;
    }

    slugStatus.textContent = "Checking…";
    slugStatus.className = "slug-status";

    slugCheckTimeout = setTimeout(async () => {
      try {
        const res = await fetch("/api/permanent-rooms/check-slug", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: raw }),
        });
        const data = await res.json();

        if (data.available) {
          slugStatus.textContent = "Available!";
          slugStatus.className = "slug-status slug-status-ok";
          slugAvailable = true;
        } else {
          slugStatus.textContent = data.reason || "Already taken";
          slugStatus.className = "slug-status slug-status-error";
        }
        updateCreateButton();
      } catch {
        slugStatus.textContent = "Could not check. Try again.";
        slugStatus.className = "slug-status slug-status-error";
      }
    }, 400);
  });

  // Enable button only when slug is available and name is filled
  inputName.addEventListener("input", updateCreateButton);

  function updateCreateButton() {
    btnCreate.disabled = !(slugAvailable && inputName.value.trim().length > 0);
  }

  // --- Create room ---
  btnCreate.addEventListener("click", createRoom);
  inputName.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !btnCreate.disabled) createRoom();
  });

  async function createRoom() {
    if (!slugAvailable || !inputName.value.trim()) return;

    btnCreate.disabled = true;
    btnCreate.textContent = "Creating…";

    try {
      const res = await fetch("/api/permanent-rooms/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId || null,
          slug: inputSlug.value,
          passphrase: inputPassphrase.value || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Could not create room.");
        btnCreate.disabled = false;
        btnCreate.textContent = "Create & Enter Room";
        return;
      }

      const data = await res.json();
      sessionStorage.setItem("displayName", inputName.value.trim());
      sessionStorage.setItem("codewordAuthenticated", data.slug);
      sessionStorage.setItem("roomJustCreated", data.slug);
      window.location.href = `/p/${data.slug}`;
    } catch {
      alert("Network error. Please try again.");
      btnCreate.disabled = false;
      btnCreate.textContent = "Create & Enter Room";
    }
  }
})();
